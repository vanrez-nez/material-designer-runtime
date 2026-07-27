import type { PbrSocket } from "../graph/types";

// The bake cache's storage port. This module imports TYPES ONLY (no three, no graph code), so a consumer can
// implement a store — server, CDN, their own IndexedDB, node fs — without pulling the renderer in.

// A channel a bake can produce. "height" is not a PbrSocket (it drives parallax, not a lit channel) but it is
// a real bake output with its own 8-bit target, so the cache carries it as a pseudo-channel.
export type BakeCacheChannel = PbrSocket | "height";

// How texels are stored on disk. All three are LOSSLESS — a restore must reproduce a bake exactly, or you
// would author against one image and get a different one back.
//   "rgba8"   raw texels. Fastest to restore (nothing to undo), largest on disk.
//   "deflate" raw texels through the browser's byte compressor. No image decoding, so restores stay quick.
//   "png"     smallest on disk, but unpacking an image is real work and restores are markedly slower.
export type BakeCacheEncoding = "png" | "rgba8" | "deflate";

// One channel's texels crossing the port. `bytes` is tightly-packed, top-down RGBA8 and `encoding` is
// "rgba8" in both directions — a store is free to compress internally (the default encodes PNG), but it decodes
// before handing anything back, so nothing above the port ever deals with a compressed buffer.
export interface BakeCacheTexels {
  channel: BakeCacheChannel;
  encoding: BakeCacheEncoding;
  bytes: Uint8Array;
}

// Everything about an entry EXCEPT the texels. `list()` returns these, which is what keeps the metrics
// endpoint and LRU eviction O(entries) rather than O(bytes) — never make a consumer read 28MB to answer
// "how big is the cache".
export interface BakeCacheEntryMeta {
  id: string;
  // The full canonical key string. Stored so a read can VERIFY it: `id` is a 64-bit hash, and comparing the
  // canonical form makes a collision a miss instead of silently restoring another document's textures.
  key: string;
  // Schema tag, so a store opened by a newer/older build can identify and drop foreign records (see gc()).
  schema: string;
  size: number;
  encoding: BakeCacheEncoding;
  channels: BakeCacheChannel[];
  hasHeight: boolean;
  // Total bytes AS STORED across all channels — what the LRU budget and the metrics endpoint work in.
  //
  // A store that compresses (the default encodes PNG) MUST overwrite this with the post-encode size on `put`.
  // The value the cache hands in is the raw texel size, used only for the pre-write policy gate; reporting
  // that as "size taken" once the bytes are compressed would be wrong.
  bytes: number;
  // Wall time of the bake this entry replaces. The entry's value IS this number: it's what a hit skips.
  bakeMs: number;
  createdAt: number;
  lastUsedAt: number;
}

// A complete cache record: metadata plus the texels. Atomic by design — one record per bake, never one per
// channel. A partially-evicted per-channel scheme would restore 5 of 7 channels and render a silently WRONG
// material, which is worse than a miss.
export interface BakeCacheEntry extends BakeCacheEntryMeta {
  textures: BakeCacheTexels[];
}

// What a caller hands to `BakeTextureCache.write` — the cache stamps the metadata itself.
export interface BakeCachePayload {
  size: number;
  channels: BakeCacheChannel[];
  hasHeight: boolean;
  bakeMs: number;
  textures: BakeCacheTexels[];
}

export interface BakeCacheStoreEstimate {
  entries: number;
  bytes: number;
}

// The port. Implement this to back the cache with your own storage.
//
// Contract notes that are load-bearing rather than stylistic:
//   - Async-only. IndexedDB, fetch, and fs.promises are all async; a sync port would exclude every real backend.
//   - `touch` must NOT rewrite the texels. It is called on every cache hit to bump LRU position; rewriting
//     ~28MB per hit would make the cache slower than the bake it replaces.
//   - `list` must NOT return texels. See BakeCacheEntryMeta.
//   - Throwing is acceptable. Every call site wraps the store, and a failure degrades to a normal bake.
export interface BakeCacheStore {
  // Identifies the implementation in metrics: "indexeddb" | "memory" | whatever you call yours.
  readonly name: string;
  get(id: string): Promise<BakeCacheEntry | null>;
  put(entry: BakeCacheEntry): Promise<void>;
  touch(id: string, lastUsedAt: number): Promise<void>;
  delete(id: string): Promise<void>;
  list(): Promise<BakeCacheEntryMeta[]>;
  clear(): Promise<void>;
  // Optional fast path for the metrics endpoint; the cache falls back to summing list().
  estimate?(): Promise<BakeCacheStoreEstimate>;
}

export type BakeCacheEventKind =
  | "hit"
  | "miss"
  | "write"
  | "evict"
  | "collision"
  | "disabled"
  | "error";

export interface BakeCacheEvent {
  kind: BakeCacheEventKind;
  id?: string;
  bytes?: number;
  message?: string;
}

export interface BakeCacheOptions {
  // OPT-IN. Left false, nothing is persisted and no storage is touched.
  enabled?: boolean;
  // Bring your own storage. Omitted → IndexedDB when available, else an in-memory store (which still helps
  // within a session but does not survive a reload); check `metrics().store` to see which you got.
  store?: BakeCacheStore;
  encoding?: BakeCacheEncoding;
  // On-disk budget, in bytes AS STORED (post-compression). LRU-evicted down to it on every write. This is
  // the knob that governs actual footprint.
  budgetBytes?: number;
  // Ceiling on a single capture, in RAW texel bytes (pre-compression) — a different currency from
  // `budgetBytes`, because this gate runs BEFORE the readback, when the stored size isn't knowable yet.
  // It bounds the transient cost of capturing: the GPU→CPU transfer and the JS buffers it allocates.
  //
  // Size it against raw totals, not what you expect on disk: a full 7-channel bake is ~28 MB at 1024²,
  // ~112 MB at 2048², and ~448 MB at 4096². Setting this to the disk figure you have in mind will silently
  // stop caching your larger materials — the compression ratio is often 10× or more, so the two numbers are
  // nowhere near each other.
  maxEntryBytes?: number;
  // Don't spend a ~28MB readback to save a bake faster than this. The gate reads the REBUILD time, because
  // an entry's worth is the shader compile it lets you skip.
  minBakeMs?: number;
  // Quiet period after a bake before the (main-thread, GPU) capture is scheduled. Keeps a slider drag from
  // paying a readback per tick.
  writeDelayMs?: number;
  // Run the codec and storage IO off the main thread. `{ url }` points at a self-hosted worker file, for a
  // CSP that forbids blob: in worker-src.
  worker?: boolean | { url: string | URL };
  // Folded into the key — a lever for invalidating your own entries without touching the runtime version.
  namespace?: string;
  onEvent?: (event: BakeCacheEvent) => void;
}

export interface BakeCacheMetrics {
  enabled: boolean;
  // False when no usable store exists (no IndexedDB, no Worker, SSR); every operation is a silent no-op.
  available: boolean;
  store: string;
  encoding: BakeCacheEncoding;
  entries: number;
  bytes: number;
  budgetBytes: number;
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
  collisions: number;
  // navigator.storage.estimate(), when the browser offers it — the origin's whole quota, not just ours.
  quota: { usage: number; quota: number } | null;
  lastError: string | null;
}
