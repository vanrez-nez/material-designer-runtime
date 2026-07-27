import CacheWorker from "./cache.worker?worker&inline";
import type {
  BakeCacheEncoding,
  BakeCacheEntry,
  BakeCacheEntryMeta,
  BakeCacheStore,
  BakeCacheStoreEstimate,
} from "./types";

// Presents the cache worker as an ordinary BakeCacheStore, so nothing above this file knows a worker exists.
//
// PACKAGING: the worker is imported `?worker&inline`, which base64-inlines it into dist/index.js at build time.
// That is the one option that works everywhere a consumer might use this package — no second dist file to ship,
// no import.meta.url resolution to get wrong, and identical behaviour whether you consume the source through
// the editor's Vite alias or the built ESM from npm/webpack.
//
// The trade-off is that Vite's inline worker constructs a blob: URL, so a Content-Security-Policy without
// `blob:` in `worker-src` will refuse it. That failure is caught in `isWorkerCacheAvailable` /
// `createWorkerCacheStore`, which fall back rather than throwing; a consumer under strict CSP can host the
// worker file themselves and pass `worker: { url }`.

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface WorkerCacheStoreOptions {
  namespace?: string;
  encoding?: BakeCacheEncoding;
  // Self-hosted worker URL, for a CSP that forbids blob: workers.
  url?: string | URL;
}

export function isWorkerCacheAvailable(): boolean {
  return typeof Worker !== "undefined" && typeof indexedDB !== "undefined";
}

function spawn(url?: string | URL): Worker {
  if (url) return new Worker(url, { type: "module" });
  return new CacheWorker();
}

// Returns null when a worker can't be created — no Worker constructor (node/SSR), no IndexedDB, or a CSP that
// blocks the blob: URL. Callers fall back to the main-thread store.
export function createWorkerCacheStore(options: WorkerCacheStoreOptions = {}): BakeCacheStore | null {
  if (!isWorkerCacheAvailable()) return null;
  let worker: Worker;
  try {
    worker = spawn(options.url);
  } catch {
    return null;
  }

  const pending = new Map<number, PendingCall>();
  let nextId = 1;
  let broken: Error | null = null;

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const { id, ok, result, error } = event.data;
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    if (ok) call.resolve(result);
    else call.reject(new Error(error ?? "cache worker error"));
  };

  // A worker that dies (OOM, an uncaught throw in the message loop) must not leave every caller awaiting
  // forever. Latch the failure, reject everything outstanding, and reject fast from then on so the policy layer
  // records a lastError and degrades instead of hanging the bake path.
  const die = (message: string): void => {
    broken = new Error(message);
    for (const call of pending.values()) call.reject(broken);
    pending.clear();
  };
  worker.onerror = (event: ErrorEvent) => die(event.message || "cache worker crashed");
  worker.onmessageerror = () => die("cache worker message could not be deserialized");

  const call = <T>(op: string, payload?: unknown, transfer: ArrayBuffer[] = []): Promise<T> => {
    if (broken) return Promise.reject(broken);
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        worker.postMessage({ id, op, payload }, transfer);
      } catch (err) {
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  void call("configure", { namespace: options.namespace ?? "", encoding: options.encoding ?? "png" });

  return {
    name: "worker-indexeddb",
    async get(id) {
      return (await call<BakeCacheEntry | null>("get", id)) ?? null;
    },
    async put(entry) {
      // Transfer every channel's buffer: ownership moves to the worker, so a ~28MB write costs the main thread
      // no copying at all. The entry is dead to us afterwards, which is fine — the caller built it for this.
      const transfer = entry.textures.map((t) => t.bytes.buffer as ArrayBuffer);
      await call<void>("put", entry, transfer);
    },
    async touch(id, lastUsedAt) {
      await call<void>("touch", { id, lastUsedAt });
    },
    async delete(id) {
      await call<void>("delete", id);
    },
    async list() {
      return call<BakeCacheEntryMeta[]>("list");
    },
    async clear() {
      await call<void>("clear");
    },
    async estimate(): Promise<BakeCacheStoreEstimate> {
      return call<BakeCacheStoreEstimate>("estimate");
    },
  };
}
