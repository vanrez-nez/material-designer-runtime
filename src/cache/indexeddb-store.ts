import { decodeTexels, encodeTexels } from "./codec";
import {
  dbNameFor,
  idbClear,
  idbDelete,
  idbGet,
  idbList,
  idbPut,
  idbTouch,
  isIndexedDbAvailable,
  openBakeCacheDb,
  toStandaloneBuffer,
  type StoredData,
} from "./idb-core";
import { createMemoryCacheStore } from "./memory-store";
import { createWorkerCacheStore } from "./worker-client";
import type {
  BakeCacheEncoding,
  BakeCacheEntryMeta,
  BakeCacheStore,
  BakeCacheStoreEstimate,
  BakeCacheTexels,
} from "./types";

export {
  BAKE_CACHE_DB_NAME,
  BAKE_CACHE_DB_VERSION,
  isIndexedDbAvailable,
} from "./idb-core";

export interface IndexedDbCacheStoreOptions {
  namespace?: string;
  encoding?: BakeCacheEncoding;
}

// Main-thread IndexedDB store. Identical on-disk format to the worker's (both go through idb-core + codec), so
// entries written by one are readable by the other — which matters, because whether a worker is available can
// differ between sessions on the same origin.
//
// Prefer createWorkerCacheStore: encoding a 1024² channel to PNG costs tens to low hundreds of milliseconds,
// and this path spends that on the main thread. It exists for node/SSR, and for a CSP that blocks blob: workers.
export function createIndexedDbCacheStore(options: IndexedDbCacheStoreOptions = {}): BakeCacheStore {
  const dbName = dbNameFor(options.namespace ?? "");
  const encoding = options.encoding ?? "png";
  let dbPromise: Promise<IDBDatabase> | null = null;

  const db = (): Promise<IDBDatabase> => {
    // Drop a REJECTED promise so a transient open failure doesn't poison every later call for the page's life.
    if (!dbPromise) {
      dbPromise = openBakeCacheDb(dbName).catch((err: unknown) => {
        dbPromise = null;
        throw err;
      });
    }
    return dbPromise;
  };

  return {
    name: "indexeddb",

    async get(id) {
      const found = await idbGet(await db(), id);
      if (!found) return null;
      const { meta, data } = found;
      const textures: BakeCacheTexels[] = [];
      for (const stored of data.textures) {
        textures.push({
          channel: stored.channel,
          encoding: "rgba8",
          bytes: await decodeTexels(new Uint8Array(stored.bytes), meta.size, stored.encoding),
        });
      }
      return { ...meta, textures };
    },

    async put(entry) {
      const textures = [];
      let storedBytes = 0;
      for (const texels of entry.textures) {
        const encoded = await encodeTexels(texels.bytes, entry.size, encoding);
        storedBytes += encoded.bytes.byteLength;
        textures.push({
          channel: texels.channel,
          encoding: encoded.encoding,
          bytes: toStandaloneBuffer(encoded.bytes),
        });
      }
      const { textures: _drop, ...rest } = entry;
      // Size AS STORED — metrics().bytes and the LRU budget both read this, and reporting pre-compression
      // bytes as "size taken" would simply be wrong.
      const meta: BakeCacheEntryMeta = { ...rest, bytes: storedBytes };
      const data: StoredData = { id: entry.id, textures };
      await idbPut(await db(), meta, data);
    },

    async touch(id, lastUsedAt) {
      await idbTouch(await db(), id, lastUsedAt);
    },

    async delete(id) {
      await idbDelete(await db(), id);
    },

    async list() {
      return idbList(await db());
    },

    async clear() {
      await idbClear(await db());
    },

    async estimate(): Promise<BakeCacheStoreEstimate> {
      const metas = await idbList(await db());
      let bytes = 0;
      for (const meta of metas) bytes += meta.bytes;
      return { entries: metas.length, bytes };
    },
  };
}

export interface DefaultCacheStoreOptions extends IndexedDbCacheStoreOptions {
  // false → skip the worker and encode/store on the main thread. `{ url }` → a self-hosted worker file, for a
  // CSP that forbids blob: workers.
  worker?: boolean | { url: string | URL };
}

// The store a BakeTextureCache builds when the consumer didn't supply one, in descending order of preference:
//
//   1. worker + IndexedDB — persists across sessions, and neither the PNG codec nor the storage IO touches the
//      main thread.
//   2. main-thread IndexedDB — still persists; pays the codec cost on the main thread.
//   3. in-memory — no persistence, but still worth having: flip away from a document and back within a session
//      and it restores instead of recompiling.
//
// `metrics().store` reports which one you actually got, so "why isn't my cache persisting?" is answerable
// rather than mysterious.
export function createDefaultCacheStore(options: DefaultCacheStoreOptions = {}): BakeCacheStore {
  const { worker = true, ...storeOptions } = options;
  if (worker !== false) {
    const workerStore = createWorkerCacheStore({
      ...storeOptions,
      url: typeof worker === "object" ? worker.url : undefined,
    });
    if (workerStore) return workerStore;
  }
  if (isIndexedDbAvailable()) return createIndexedDbCacheStore(storeOptions);
  return createMemoryCacheStore();
}
