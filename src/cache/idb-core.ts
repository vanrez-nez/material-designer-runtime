import type { BakeCacheChannel, BakeCacheEncoding, BakeCacheEntryMeta } from "./types";

// Raw IndexedDB primitives for the bake cache, with no encoding and no policy. Shared verbatim by the cache
// worker and by the main-thread fallback store, so the two can never drift into storing different shapes.
//
// Two object stores, and the split is the point:
//   - `meta` holds BakeCacheEntryMeta only. list() reads just this, so "how big is the cache" and "what should
//     I evict" cost kilobytes instead of deserializing hundreds of megabytes of texels.
//   - `data` holds the encoded texels under the same id.
// A put writes both in ONE readwrite transaction, so a record is never half-present.
//
// This is the runtime's first binary store. Everything else this project persists is JSON in localStorage, so
// a consumer's "clear all my data" path will NOT catch it — hence BAKE_CACHE_DB_NAME is exported.
export const BAKE_CACHE_DB_NAME = "material-designer-textures";
export const BAKE_CACHE_DB_VERSION = 1;

export const META_STORE = "meta";
export const DATA_STORE = "data";

// Texels as they sit on disk: an ArrayBuffer (what structured clone stores most directly) plus the encoding
// needed to read them back. Self-describing, so changing the configured encoding never invalidates or
// misreads existing records.
export interface StoredTexels {
  channel: BakeCacheChannel;
  encoding: BakeCacheEncoding;
  bytes: ArrayBuffer;
}

export interface StoredData {
  id: string;
  textures: StoredTexels[];
}

export function isIndexedDbAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    // Merely touching indexedDB throws in some locked-down / storage-blocked contexts.
    return false;
  }
}

export function dbNameFor(namespace: string): string {
  return namespace ? `${BAKE_CACHE_DB_NAME}-${namespace}` : BAKE_CACHE_DB_NAME;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

// Resolve when the transaction COMMITS, not when the last request succeeds. A put that resolved on request
// success could report durability and then fail at commit — which is exactly when a quota error surfaces — so
// the caller's quota handling depends on waiting for this.
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

export function openBakeCacheDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, BAKE_CACHE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(DATA_STORE)) db.createObjectStore(DATA_STORE, { keyPath: "id" });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Without this, another tab upgrading the schema would be blocked by this connection forever.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    req.onblocked = () => reject(new Error("IndexedDB open blocked by another connection"));
  });
}

export async function idbGet(
  db: IDBDatabase,
  id: string,
): Promise<{ meta: BakeCacheEntryMeta; data: StoredData } | null> {
  const tx = db.transaction([META_STORE, DATA_STORE], "readonly");
  const [meta, data] = await Promise.all([
    request<BakeCacheEntryMeta | undefined>(tx.objectStore(META_STORE).get(id)),
    request<StoredData | undefined>(tx.objectStore(DATA_STORE).get(id)),
  ]);
  // A half-record (interrupted write, partial manual deletion) counts as absent. Restoring it would mean a
  // material with missing channels, which renders wrong rather than obviously broken.
  if (!meta || !data) return null;
  return { meta, data };
}

export async function idbPut(
  db: IDBDatabase,
  meta: BakeCacheEntryMeta,
  data: StoredData,
): Promise<void> {
  const tx = db.transaction([META_STORE, DATA_STORE], "readwrite");
  tx.objectStore(META_STORE).put(meta);
  tx.objectStore(DATA_STORE).put(data);
  await transactionDone(tx);
}

// Rewrites the ~200-byte meta row only; the texels live in a separate store and are not touched. That is the
// whole reason for the split, since this runs on every cache hit.
export async function idbTouch(db: IDBDatabase, id: string, lastUsedAt: number): Promise<void> {
  const tx = db.transaction(META_STORE, "readwrite");
  const store = tx.objectStore(META_STORE);
  const meta = await request<BakeCacheEntryMeta | undefined>(store.get(id));
  if (meta) store.put({ ...meta, lastUsedAt });
  await transactionDone(tx);
}

export async function idbDelete(db: IDBDatabase, id: string): Promise<void> {
  const tx = db.transaction([META_STORE, DATA_STORE], "readwrite");
  tx.objectStore(META_STORE).delete(id);
  tx.objectStore(DATA_STORE).delete(id);
  await transactionDone(tx);
}

export async function idbList(db: IDBDatabase): Promise<BakeCacheEntryMeta[]> {
  const tx = db.transaction(META_STORE, "readonly");
  return request<BakeCacheEntryMeta[]>(
    tx.objectStore(META_STORE).getAll() as IDBRequest<BakeCacheEntryMeta[]>,
  );
}

export async function idbClear(db: IDBDatabase): Promise<void> {
  const tx = db.transaction([META_STORE, DATA_STORE], "readwrite");
  tx.objectStore(META_STORE).clear();
  tx.objectStore(DATA_STORE).clear();
  await transactionDone(tx);
}

// Hand IndexedDB a standalone ArrayBuffer. Passing a Uint8Array view over a larger or pooled buffer would
// serialize the whole backing store rather than just this channel's slice.
export function toStandaloneBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}
