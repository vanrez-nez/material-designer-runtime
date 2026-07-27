import type {
  BakeCacheEntry,
  BakeCacheEntryMeta,
  BakeCacheStore,
  BakeCacheStoreEstimate,
} from "./types";

// The reference BakeCacheStore: a plain Map. Two jobs.
//
//  1. It is the fallback when IndexedDB is unavailable (Safari private mode, SSR, a locked-down origin). The
//     cache still pays off WITHIN a session — a document you flip away from and back to restores instead of
//     recompiling — it just doesn't survive a reload. `metrics().store` says "memory" so a consumer can tell.
//  2. It is the test double. Every policy test in test/bake-cache.test.ts runs against this, which is what
//     makes the whole eviction/budget/collision surface testable in pure node with no GPU and no browser.
//
// Entries are cloned on the way in and out. Without that, a caller mutating the Uint8Array it handed us (or
// one we returned) would corrupt the store — cheap insurance, and it matches what a real serializing backend
// does implicitly.
function cloneTexels(entry: BakeCacheEntry): BakeCacheEntry {
  return {
    ...entry,
    channels: [...entry.channels],
    textures: entry.textures.map((t) => ({ ...t, bytes: new Uint8Array(t.bytes) })),
  };
}

function metaOf(entry: BakeCacheEntry): BakeCacheEntryMeta {
  // Deliberately destructures `textures` away — list() must never return texels (see BakeCacheEntryMeta).
  const { textures: _textures, ...meta } = entry;
  return { ...meta, channels: [...meta.channels] };
}

export function createMemoryCacheStore(): BakeCacheStore {
  const entries = new Map<string, BakeCacheEntry>();
  return {
    name: "memory",
    async get(id) {
      const entry = entries.get(id);
      return entry ? cloneTexels(entry) : null;
    },
    async put(entry) {
      entries.set(entry.id, cloneTexels(entry));
    },
    async touch(id, lastUsedAt) {
      const entry = entries.get(id);
      if (entry) entry.lastUsedAt = lastUsedAt;
    },
    async delete(id) {
      entries.delete(id);
    },
    async list() {
      return [...entries.values()].map(metaOf);
    },
    async clear() {
      entries.clear();
    },
    async estimate(): Promise<BakeCacheStoreEstimate> {
      let bytes = 0;
      for (const entry of entries.values()) bytes += entry.bytes;
      return { entries: entries.size, bytes };
    },
  };
}
