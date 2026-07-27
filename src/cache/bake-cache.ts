import { BAKE_CACHE_SCHEMA, type BakeCacheKey } from "./key";
import { createDefaultCacheStore } from "./indexeddb-store";
import type {
  BakeCacheEntry,
  BakeCacheEntryMeta,
  BakeCacheEvent,
  BakeCacheMetrics,
  BakeCacheOptions,
  BakeCachePayload,
  BakeCacheStore,
  BakeCacheTexels,
} from "./types";

const DEFAULT_BUDGET_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MIN_BAKE_MS = 250;
const DEFAULT_WRITE_DELAY_MS = 750;

function totalBytes(textures: readonly BakeCacheTexels[]): number {
  let bytes = 0;
  for (const t of textures) bytes += t.bytes.byteLength;
  return bytes;
}

function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

// Policy layer over a BakeCacheStore. Everything that decides WHETHER to cache lives here; the store only
// decides WHERE.
//
// The governing invariant: **this class must never be able to break a bake.** Every store call goes through
// `guard`, which swallows the failure, records it, and returns a fallback that reads as a miss. A cache that
// throws into `bakeInto` would turn a performance feature into an outage, so there is no code path where a
// storage problem escapes.
export class BakeTextureCache {
  private store: BakeCacheStore | null;
  // True when WE built the store, so reconfiguring `encoding`/`namespace` (both of which are properties of the
  // store, not of this class) may rebuild it. A consumer-supplied store is never swapped out from under them.
  private ownsStore: boolean;
  private enabled_: boolean;
  private options: Required<
    Pick<
      BakeCacheOptions,
      "encoding" | "budgetBytes" | "maxEntryBytes" | "minBakeMs" | "writeDelayMs" | "namespace"
    >
  >;
  private onEvent: ((event: BakeCacheEvent) => void) | undefined;
  private workerOption: BakeCacheOptions["worker"];
  private hits = 0;
  private misses = 0;
  private writes = 0;
  private evictions = 0;
  private collisions = 0;
  private lastError_: string | null = null;
  // Two consecutive quota failures mean the origin is full and evicting isn't helping. Latch off rather than
  // retrying forever on every bake.
  private quotaFailures = 0;
  private gcDone = false;

  constructor(options: BakeCacheOptions = {}) {
    const encoding = options.encoding ?? "png";
    this.ownsStore = options.store === undefined;
    this.workerOption = options.worker;
    this.store =
      options.store ??
      createDefaultCacheStore({
        namespace: options.namespace ?? "",
        encoding,
        worker: options.worker,
      });
    this.enabled_ = options.enabled ?? false;
    this.onEvent = options.onEvent;
    this.options = {
      // PNG by default: the codec runs in the worker, so the size win costs the main thread nothing. The
      // encoding is a property of the STORE — texels crossing this class are always plain RGBA8 — and each
      // stored record records its own format, so changing this never misreads an existing entry.
      encoding,
      budgetBytes: options.budgetBytes ?? DEFAULT_BUDGET_BYTES,
      maxEntryBytes: options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES,
      minBakeMs: options.minBakeMs ?? DEFAULT_MIN_BAKE_MS,
      writeDelayMs: options.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS,
      namespace: options.namespace ?? "",
    };
  }

  // --- configuration ------------------------------------------------------------------------------
  get enabled(): boolean {
    return this.enabled_ && this.store !== null;
  }

  // False once no usable store exists — either none was resolvable or the cache latched off after repeated
  // storage failures. Read `storeName` to tell whether what you got persists across sessions ("memory" does not).
  get available(): boolean {
    return this.store !== null;
  }

  get storeName(): string {
    return this.store?.name ?? "none";
  }

  get encoding(): BakeCacheOptions["encoding"] {
    return this.options.encoding;
  }

  get namespace(): string {
    return this.options.namespace;
  }

  get writeDelayMs(): number {
    return this.options.writeDelayMs;
  }

  get lastError(): string | null {
    return this.lastError_;
  }

  setEnabled(on: boolean): void {
    this.enabled_ = on;
  }

  configure(patch: BakeCacheOptions): void {
    if (patch.store !== undefined) {
      this.store = patch.store;
      this.ownsStore = false;
      this.gcDone = false;
      this.quotaFailures = 0;
    }
    if (patch.enabled !== undefined) this.enabled_ = patch.enabled;
    if (patch.onEvent !== undefined) this.onEvent = patch.onEvent;
    if (patch.budgetBytes !== undefined) this.options.budgetBytes = patch.budgetBytes;
    if (patch.maxEntryBytes !== undefined) this.options.maxEntryBytes = patch.maxEntryBytes;
    if (patch.minBakeMs !== undefined) this.options.minBakeMs = patch.minBakeMs;
    if (patch.writeDelayMs !== undefined) this.options.writeDelayMs = patch.writeDelayMs;
    if (patch.worker !== undefined) this.workerOption = patch.worker;
    // `encoding` and `namespace` belong to the STORE, so changing either has to rebuild it — otherwise
    // metrics().encoding would advertise a format the store isn't using. Only ever rebuilds a store we own.
    const encodingChanged = patch.encoding !== undefined && patch.encoding !== this.options.encoding;
    const namespaceChanged = patch.namespace !== undefined && patch.namespace !== this.options.namespace;
    if (patch.encoding !== undefined) this.options.encoding = patch.encoding;
    if (patch.namespace !== undefined) this.options.namespace = patch.namespace;
    if ((encodingChanged || namespaceChanged || patch.worker !== undefined) && this.ownsStore) {
      this.store = createDefaultCacheStore({
        namespace: this.options.namespace,
        encoding: this.options.encoding,
        worker: this.workerOption,
      });
      this.gcDone = false;
      this.quotaFailures = 0;
    }
  }

  // --- reads --------------------------------------------------------------------------------------
  // Load an entry, or null for any reason at all (disabled, absent, collision, storage failure). Callers treat
  // null as "fall through to a normal bake", so this never needs to distinguish.
  async read(key: BakeCacheKey): Promise<BakeCacheEntry | null> {
    if (!this.enabled || !this.store) return null;
    await this.ensureGc();
    const entry = await this.guard("read", () => this.store!.get(key.id), null);
    if (!entry) {
      this.misses += 1;
      this.emit({ kind: "miss", id: key.id });
      return null;
    }
    // `id` is a 64-bit hash; comparing the canonical body is what makes a collision a miss instead of
    // restoring another document's textures. Drop the loser so we don't re-check it on every bake.
    if (entry.key !== key.key) {
      this.collisions += 1;
      this.misses += 1;
      this.emit({ kind: "collision", id: key.id });
      await this.guard("collision-delete", () => this.store!.delete(key.id), undefined);
      return null;
    }
    this.hits += 1;
    this.emit({ kind: "hit", id: key.id, bytes: entry.bytes });
    // Fire-and-forget: this is the restore hot path, and an LRU bump is never worth waiting on storage for.
    void this.guard("touch", () => this.store!.touch(key.id, Date.now()), undefined);
    return entry;
  }

  // Metadata for one entry without reading its texels — what `peek`-before-capture uses to skip a ~28MB
  // readback when the entry already exists.
  async peek(key: BakeCacheKey): Promise<BakeCacheEntryMeta | null> {
    if (!this.enabled || !this.store) return null;
    const entry = await this.guard("peek", () => this.store!.get(key.id), null);
    if (!entry || entry.key !== key.key) return null;
    const { textures: _textures, ...meta } = entry;
    return meta;
  }

  async entries(): Promise<BakeCacheEntryMeta[]> {
    if (!this.store) return [];
    return this.guard("list", () => this.store!.list(), []);
  }

  // --- writes -------------------------------------------------------------------------------------
  // Sync policy pre-check. Callers MUST consult this before capturing texels: the readback is the expensive
  // part, and there is no sense paying it for a write that policy would reject.
  canWrite(bakeMs: number, bytes: number): boolean {
    if (!this.enabled || !this.store) return false;
    if (bytes <= 0 || bytes > this.options.maxEntryBytes) return false;
    return bakeMs >= this.options.minBakeMs;
  }

  async write(key: BakeCacheKey, payload: BakeCachePayload): Promise<void> {
    if (!this.enabled || !this.store) return;
    const bytes = totalBytes(payload.textures);
    if (!this.canWrite(payload.bakeMs, bytes)) return;
    const now = Date.now();
    const entry: BakeCacheEntry = {
      id: key.id,
      key: key.key,
      schema: BAKE_CACHE_SCHEMA,
      size: payload.size,
      encoding: this.options.encoding,
      channels: [...payload.channels],
      hasHeight: payload.hasHeight,
      bytes,
      bakeMs: payload.bakeMs,
      createdAt: now,
      lastUsedAt: now,
      textures: payload.textures,
    };
    // Evict first so the store is under budget BEFORE the write, rather than overshooting and trimming after.
    await this.evictTo(Math.max(0, this.options.budgetBytes - bytes), key.id);
    const ok = await this.put(entry);
    if (!ok) return;
    this.writes += 1;
    this.emit({ kind: "write", id: key.id, bytes });
  }

  async delete(key: BakeCacheKey | string): Promise<void> {
    if (!this.store) return;
    const id = typeof key === "string" ? key : key.id;
    await this.guard("delete", () => this.store!.delete(id), undefined);
  }

  async clear(): Promise<void> {
    if (!this.store) return;
    await this.guard("clear", () => this.store!.clear(), undefined);
  }

  // Drop entries written by a different build. The id prefix already means they are never looked up, so this
  // is purely about reclaiming their bytes. Runs once, lazily, on the first read.
  async gc(): Promise<number> {
    if (!this.store) return 0;
    const metas = await this.entries();
    let dropped = 0;
    for (const meta of metas) {
      if (meta.schema === BAKE_CACHE_SCHEMA) continue;
      await this.guard("gc-delete", () => this.store!.delete(meta.id), undefined);
      dropped += 1;
    }
    return dropped;
  }

  // Evict least-recently-used entries until the total is at or below `budgetBytes`.
  async evict(): Promise<number> {
    return this.evictTo(this.options.budgetBytes);
  }

  async metrics(): Promise<BakeCacheMetrics> {
    const metas = await this.entries();
    let bytes = 0;
    for (const meta of metas) bytes += meta.bytes;
    return {
      enabled: this.enabled,
      available: this.available,
      store: this.storeName,
      encoding: this.options.encoding,
      entries: metas.length,
      bytes,
      budgetBytes: this.options.budgetBytes,
      hits: this.hits,
      misses: this.misses,
      writes: this.writes,
      evictions: this.evictions,
      collisions: this.collisions,
      quota: await readQuota(),
      lastError: this.lastError_,
    };
  }

  // Sync counters for gpuInfo(), which must not await.
  info(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      store: this.storeName,
      encoding: this.options.encoding,
      hits: this.hits,
      misses: this.misses,
      writes: this.writes,
      evictions: this.evictions,
      collisions: this.collisions,
      lastError: this.lastError_,
    };
  }

  // --- internals ----------------------------------------------------------------------------------
  private async put(entry: BakeCacheEntry): Promise<boolean> {
    try {
      await this.store!.put(entry);
      this.quotaFailures = 0;
      return true;
    } catch (err) {
      if (!isQuotaError(err)) {
        this.fail("put", err);
        return false;
      }
      // The origin is full. Free real space (half the budget, not just enough for this entry) and retry once —
      // a single retry, because if evicting didn't help, hammering the disk won't either.
      this.quotaFailures += 1;
      await this.evictTo(Math.floor(this.options.budgetBytes / 2), entry.id);
      try {
        await this.store!.put(entry);
        this.quotaFailures = 0;
        return true;
      } catch (retryErr) {
        this.fail("put-retry", retryErr);
        if (this.quotaFailures >= 2) {
          this.enabled_ = false;
          this.emit({ kind: "disabled", message: "storage quota exhausted" });
        }
        return false;
      }
    }
  }

  // Evict oldest-used first until the total drops to `target`. `keepId` is the entry currently being written,
  // which must not be evicted to make room for itself.
  private async evictTo(target: number, keepId?: string): Promise<number> {
    if (!this.store) return 0;
    const metas = await this.entries();
    let total = 0;
    for (const meta of metas) total += meta.bytes;
    if (total <= target) return 0;
    const victims = metas
      .filter((meta) => meta.id !== keepId)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    let evicted = 0;
    for (const victim of victims) {
      if (total <= target) break;
      await this.guard("evict", () => this.store!.delete(victim.id), undefined);
      total -= victim.bytes;
      evicted += 1;
      this.evictions += 1;
      this.emit({ kind: "evict", id: victim.id, bytes: victim.bytes });
    }
    return evicted;
  }

  private async ensureGc(): Promise<void> {
    if (this.gcDone) return;
    this.gcDone = true;
    await this.gc();
  }

  // Run a store call so a storage failure can never reach the bake path.
  private async guard<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      this.fail(label, err);
      return fallback;
    }
  }

  private fail(label: string, err: unknown): void {
    this.lastError_ = `${label}: ${err instanceof Error ? err.message : String(err)}`;
    this.emit({ kind: "error", message: this.lastError_ });
  }

  private emit(event: BakeCacheEvent): void {
    if (!this.onEvent) return;
    // A throwing listener must not take the bake with it.
    try {
      this.onEvent(event);
    } catch {
      /* listener errors are the listener's problem */
    }
  }
}

async function readQuota(): Promise<{ usage: number; quota: number } | null> {
  const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
  if (!storage?.estimate) return null;
  try {
    const { usage, quota } = await storage.estimate();
    return { usage: usage ?? 0, quota: quota ?? 0 };
  } catch {
    return null;
  }
}
