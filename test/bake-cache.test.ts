import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import {
  BAKE_CACHE_SCHEMA,
  BakeTextureCache,
  MATERIAL_RUNTIME_VERSION,
  canEncodePng,
  channelByteLength,
  createBakeCacheKey,
  decodeTexels,
  depadRows,
  encodeTexels,
  flipRows,
  paddedBytesPerRow,
  pngRoundTripIsLossless,
  createMaterialParamKey,
  createMemoryCacheStore,
  defaultRegistry,
  fnv1a64,
  type BakeCacheChannel,
  type BakeCacheEntry,
  type BakeCacheKey,
  type BakeCachePayload,
  type BakeCacheStore,
  type BakeCacheTexels,
  type MaterialGraphDocument,
} from "../src";

// A document with one live-tweakable float (constant-field.value, default 0.5) and one colour param, so the
// tests can exercise the exact params createMaterialTopologyKey deliberately omits.
function tweakableDoc(): MaterialGraphDocument {
  return {
    version: 4,
    nodes: [
      { id: "constant", type: "constant-field", params: { value: 0.5 }, position: { x: 0, y: 0 }, enabled: true },
      { id: "tint", type: "constant-color", params: { color: "#808080" }, position: { x: 0, y: 120 }, enabled: true },
      { id: "mat", type: "shader-material", params: { materialType: "physical" }, position: { x: 320, y: 0 }, enabled: true },
      { id: "out", type: "material-output", params: { outputResolution: "1024" }, position: { x: 640, y: 0 }, enabled: true },
    ],
    edges: [
      { fromNode: "constant", fromOutput: "field", toNode: "mat", toInput: "roughness" },
      { fromNode: "tint", fromOutput: "color", toNode: "mat", toInput: "baseColor" },
      { fromNode: "mat", fromOutput: "bsdf", toNode: "out", toInput: "surface" },
    ],
  };
}

const CHANNELS: BakeCacheChannel[] = ["baseColor", "roughness", "normal"];

function keyFor(doc: MaterialGraphDocument, overrides: Partial<Parameters<typeof createBakeCacheKey>[0]> = {}) {
  return createBakeCacheKey({
    document: doc,
    registry: defaultRegistry,
    size: 1024,
    channels: CHANNELS,
    ...overrides,
  });
}

function texels(channel: BakeCacheChannel, bytes: number, fill = 7): BakeCacheTexels {
  return { channel, encoding: "rgba8", bytes: new Uint8Array(bytes).fill(fill) };
}

function payload(bytes: number, bakeMs = 1000): BakeCachePayload {
  return {
    size: 1024,
    channels: ["baseColor"],
    hasHeight: false,
    bakeMs,
    textures: [texels("baseColor", bytes)],
  };
}

function entryFor(id: string, bytes: number, lastUsedAt: number): BakeCacheEntry {
  return {
    id,
    key: `canonical:${id}`,
    schema: BAKE_CACHE_SCHEMA,
    size: 1024,
    encoding: "rgba8",
    channels: ["baseColor"],
    hasHeight: false,
    bytes,
    bakeMs: 1000,
    createdAt: lastUsedAt,
    lastUsedAt,
    textures: [texels("baseColor", bytes)],
  };
}

// Wraps a store and counts calls, so "disabled means no storage is touched" is an assertion rather than a hope.
function countingStore(inner: BakeCacheStore) {
  const calls: Record<string, number> = {};
  const bump = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const store: BakeCacheStore = {
    name: inner.name,
    get: (id) => (bump("get"), inner.get(id)),
    put: (e) => (bump("put"), inner.put(e)),
    touch: (id, t) => (bump("touch"), inner.touch(id, t)),
    delete: (id) => (bump("delete"), inner.delete(id)),
    list: () => (bump("list"), inner.list()),
    clear: () => (bump("clear"), inner.clear()),
    estimate: () => (bump("estimate"), inner.estimate!()),
  };
  return { store, calls };
}

describe("bake cache key", () => {
  it("is deterministic for the same document", () => {
    const a = keyFor(tweakableDoc());
    const b = keyFor(tweakableDoc());
    expect(a.id).toBe(b.id);
    expect(a.key).toBe(b.key);
  });

  // The complement of runtime.test.ts's "keeps topology stable for live tweakable params". The topology key
  // MUST ignore this param; the cache key MUST NOT, or a slider change would restore stale texels.
  it("changes when a live float param changes", () => {
    const doc = tweakableDoc();
    const before = keyFor(doc);
    doc.nodes[0]!.params.value = 0.67;
    expect(keyFor(doc).id).not.toBe(before.id);
  });

  it("changes when a colour param changes", () => {
    const doc = tweakableDoc();
    const before = keyFor(doc);
    doc.nodes[1]!.params.color = "#ff0000";
    expect(keyFor(doc).id).not.toBe(before.id);
  });

  // packArm on vs off must key differently, or a pack toggle could restore texels baked in the other
  // texture layout.
  it("keys packArm distinctly so a pack toggle can't restore the other layout", () => {
    const sparse = tweakableDoc(); // no packArm on the output node — packing defaults ON
    const off = tweakableDoc();
    off.nodes[3]!.params.packArm = false;
    expect(keyFor(off).id).not.toBe(keyFor(sparse).id);
    // The effective-param half of the key merges the registry default, so sparse ≡ explicit true there.
    // (The topology half keys structural params RAW — the pre-existing convention for every bool/select —
    // so the full key treats sparse and explicit-default as distinct bakes; a one-time miss, never a wrong
    // restore.)
    const explicitOn = tweakableDoc();
    explicitOn.nodes[3]!.params.packArm = true;
    expect(createMaterialParamKey(explicitOn, defaultRegistry)).toBe(
      createMaterialParamKey(sparse, defaultRegistry),
    );
  });

  // Sparse params are the norm — ctx.constant falls back to the ParamDef default — so an unset param and an
  // explicitly-default one bake identically and must share a key, or the cache misses on equivalent documents.
  it("treats an unset param as its registry default", () => {
    const explicit = tweakableDoc();
    const sparse = tweakableDoc();
    delete sparse.nodes[0]!.params.value; // default is 0.5, which `explicit` states outright
    expect(keyFor(sparse).key).toBe(keyFor(explicit).key);
  });

  it("canonicalizes equivalent values written differently", () => {
    const base = tweakableDoc();
    const asNumberColor = tweakableDoc();
    asNumberColor.nodes[1]!.params.color = 0x808080; // same colour as "#808080"
    expect(keyFor(asNumberColor).key).toBe(keyFor(base).key);

    const asStringFloat = tweakableDoc();
    asStringFloat.nodes[0]!.params.value = "0.5"; // MCP sends strings
    expect(keyFor(asStringFloat).key).toBe(keyFor(base).key);

    const withNoise = tweakableDoc();
    withNoise.nodes[0]!.params.value = 0.5000000001; // slider float noise, below the 9-digit precision
    expect(keyFor(withNoise).key).toBe(keyFor(base).key);

    const negativeZero = tweakableDoc();
    negativeZero.nodes[0]!.params.value = -0;
    const positiveZero = tweakableDoc();
    positiveZero.nodes[0]!.params.value = 0;
    expect(keyFor(negativeZero).key).toBe(keyFor(positiveZero).key);
  });

  it("ignores cosmetics", () => {
    const before = keyFor(tweakableDoc());
    const doc = tweakableDoc();
    doc.nodes[0]!.label = "Roughness driver";
    doc.nodes[0]!.position = { x: 999, y: -42 };
    doc.metadata = { title: "renamed" };
    doc.ui = { editor: { view: { transform: { k: 2, x: 10, y: 20 } } } };
    expect(keyFor(doc).id).toBe(before.id);
  });

  it("changes with bake size, channel set, namespace and backend", () => {
    const doc = tweakableDoc();
    const base = keyFor(doc);
    expect(keyFor(doc, { size: 512 }).id).not.toBe(base.id);
    expect(keyFor(doc, { channels: ["baseColor"] }).id).not.toBe(base.id);
    expect(keyFor(doc, { namespace: "other" }).id).not.toBe(base.id);
    expect(keyFor(doc, { backend: "webgl" }).id).not.toBe(base.id);
  });

  it("is insensitive to channel order", () => {
    const doc = tweakableDoc();
    expect(keyFor(doc, { channels: ["normal", "baseColor", "roughness"] }).id).toBe(keyFor(doc).id);
  });

  it("is insensitive to node order", () => {
    const doc = tweakableDoc();
    const shuffled = tweakableDoc();
    shuffled.nodes.reverse();
    expect(keyFor(shuffled).key).toBe(keyFor(doc).key);
  });

  it("recurses into subgraph params", () => {
    const outer = (value: number): MaterialGraphDocument => ({
      version: 4,
      nodes: [
        {
          id: "grp",
          type: "group",
          params: {},
          enabled: true,
          ports: { inputs: [], outputs: [] },
          subgraph: {
            version: 4,
            nodes: [{ id: "inner", type: "constant-field", params: { value }, enabled: true }],
            edges: [],
          },
        },
      ],
      edges: [],
    });
    const before = createMaterialParamKey(outer(0.25), defaultRegistry);
    expect(createMaterialParamKey(outer(0.75), defaultRegistry)).not.toBe(before);
    expect(createMaterialParamKey(outer(0.25), defaultRegistry)).toBe(before);
  });

  it("keys unknown node types conservatively rather than throwing", () => {
    const doc: MaterialGraphDocument = {
      version: 4,
      nodes: [{ id: "custom", type: "consumer-custom-node", params: { amount: 3 }, enabled: true }],
      edges: [],
    };
    const before = createMaterialParamKey(doc, defaultRegistry);
    expect(before).toContain("custom");
    doc.nodes[0]!.params.amount = 4;
    expect(createMaterialParamKey(doc, defaultRegistry)).not.toBe(before);
  });

  it("produces distinct ids across many distinct documents", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const doc = tweakableDoc();
      doc.nodes[0]!.params.value = i / 500;
      ids.add(keyFor(doc).id);
    }
    expect(ids.size).toBe(500);
  });

  it("hashes deterministically and distinguishes inputs", () => {
    expect(fnv1a64("material-designer")).toBe(fnv1a64("material-designer"));
    expect(fnv1a64("a")).not.toBe(fnv1a64("b"));
    expect(fnv1a64("")).toHaveLength(16);
    expect(fnv1a64("abc")).toMatch(/^[0-9a-f]{16}$/);
  });

  // The cache key embeds the runtime version so that node-maths changes (which ship without a document-schema
  // bump) orphan stale entries rather than silently restoring pre-fix texels. The version is derived from
  // package.json, so what needs guarding is no longer "are the two in sync" but "did the derivation survive" —
  // an empty or undefined version would collapse every release into one cache namespace.
  it("carries a real package version into the cache key", () => {
    expect(MATERIAL_RUNTIME_VERSION).toBe(pkg.version);
    expect(MATERIAL_RUNTIME_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    const key = keyFor(tweakableDoc());
    expect(key.id).toContain(MATERIAL_RUNTIME_VERSION);
  });

  it("orphans entries from a different runtime version", () => {
    // Two builds of the library must never share a cache entry, because the same document can bake to
    // different texels across versions. The id prefix is what enforces that.
    const key = keyFor(tweakableDoc());
    expect(key.id.startsWith(BAKE_CACHE_SCHEMA)).toBe(true);
    expect(BAKE_CACHE_SCHEMA).toContain(MATERIAL_RUNTIME_VERSION);
  });
});

// The capture/restore round trip is byte-exact only if this arithmetic is right, and it is the one part of the
// GPU path that can be tested without a GPU. A mistake here shows up as a subtly sheared or offset texture,
// which is exactly the kind of bug that survives a casual look at a render.
describe("texel row arithmetic", () => {
  function rows(width: number, height: number): Uint8Array {
    // Tag every pixel with its row index, so a reordering is unmistakable.
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) out.fill(y + 1, y * width * 4, (y + 1) * width * 4);
    return out;
  }

  it("computes tight and 256-aligned strides", () => {
    expect(channelByteLength(1024)).toBe(1024 * 1024 * 4);
    // 1024*4 = 4096 is already a multiple of 256, which is why the existing readImage path never needed to
    // de-pad at multiple-of-64 sizes.
    expect(paddedBytesPerRow(1024)).toBe(4096);
    expect(paddedBytesPerRow(64)).toBe(256);
    // 100*4 = 400 → padded up to 512.
    expect(paddedBytesPerRow(100)).toBe(512);
  });

  it("flipRows is its own inverse", () => {
    const src = rows(3, 5);
    expect([...flipRows(flipRows(src, 3, 5), 3, 5)]).toEqual([...src]);
  });

  it("flipRows reverses row order", () => {
    // 2x2, one byte-value per row: row0 = 1s, row1 = 2s.
    const src = rows(2, 2);
    const flipped = flipRows(src, 2, 2);
    expect([...flipped.subarray(0, 8)]).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
    expect([...flipped.subarray(8, 16)]).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("passes an already-tight buffer through untouched", () => {
    // The WebGL2 fallback returns tight rows regardless of width, so this case must not be "corrected".
    const tight = rows(100, 3);
    expect(depadRows(tight, 100, 3)).toBe(tight);
  });

  it("strips 256-byte row padding, including the short final row", () => {
    const width = 100;
    const height = 3;
    const bytesPerRow = paddedBytesPerRow(width); // 512, vs 400 tight
    // Three sizes the readback buffer as (height-1)*bytesPerRow + width*4 — the last row is NOT padded.
    const padded = new Uint8Array((height - 1) * bytesPerRow + width * 4);
    for (let y = 0; y < height; y++) {
      padded.fill(y + 1, y * bytesPerRow, y * bytesPerRow + width * 4);
      // Leave the gap bytes as 0 so they'd be obvious if they leaked into the output.
    }
    const tight = depadRows(padded, width, height);
    expect(tight.length).toBe(width * height * 4);
    expect(tight[0]).toBe(1);
    expect(tight[width * 4]).toBe(2); // row 1 starts exactly at the tight stride
    expect(tight[2 * width * 4]).toBe(3);
    expect([...tight].filter((b) => b === 0)).toHaveLength(0); // no padding bytes leaked through
  });
});

// This suite runs in node, where OffscreenCanvas does not exist — which makes it the right place to pin the
// graceful-degradation contract. The PNG path itself is verified in a browser (see pngRoundTripIsLossless),
// since only a real canvas can prove the premultiply / colour-management handling.
describe("texel codec fallback (no canvas)", () => {
  it("reports PNG unavailable rather than throwing", async () => {
    expect(canEncodePng()).toBe(false);
    expect(await pngRoundTripIsLossless(8)).toBe(false);
  });

  it("falls back to raw when PNG is requested but unavailable", async () => {
    const texels = new Uint8Array(8 * 8 * 4).fill(3);
    const encoded = await encodeTexels(texels, 8, "png");
    // Crucially it reports what it ACTUALLY did, so the stored record is self-describing and a later read on a
    // PNG-capable engine still decodes it correctly.
    expect(encoded.encoding).toBe("rgba8");
    expect(encoded.bytes).toBe(texels);
  });

  it("round-trips raw texels unchanged", async () => {
    const texels = new Uint8Array(8 * 8 * 4).fill(9);
    const encoded = await encodeTexels(texels, 8, "rgba8");
    expect([...(await decodeTexels(encoded.bytes, 8, "rgba8"))]).toEqual([...texels]);
  });

  it("rejects a decoded buffer of the wrong size", async () => {
    // A truncated/corrupt record must surface as an error the cache turns into a miss, never as a short buffer
    // that would be uploaded as a garbled texture.
    await expect(decodeTexels(new Uint8Array(16), 8, "rgba8")).rejects.toThrow(/expected 256/);
  });
});

describe("bake cache store contract (memory reference impl)", () => {
  it("round-trips an entry byte for byte", async () => {
    const store = createMemoryCacheStore();
    const entry = entryFor("a", 64, 1);
    entry.textures[0]!.bytes = new Uint8Array([1, 2, 3, 250]);
    await store.put(entry);
    const got = await store.get("a");
    expect(got).not.toBeNull();
    expect([...got!.textures[0]!.bytes]).toEqual([1, 2, 3, 250]);
  });

  it("isolates stored bytes from later caller mutation", async () => {
    const store = createMemoryCacheStore();
    const entry = entryFor("a", 4, 1);
    await store.put(entry);
    entry.textures[0]!.bytes.fill(99); // caller reuses its buffer
    const got = await store.get("a");
    expect([...got!.textures[0]!.bytes]).toEqual([7, 7, 7, 7]);
  });

  it("never returns texels from list()", async () => {
    const store = createMemoryCacheStore();
    await store.put(entryFor("a", 64, 1));
    const metas = await store.list();
    expect(metas).toHaveLength(1);
    expect((metas[0] as Partial<BakeCacheEntry>).textures).toBeUndefined();
    expect(metas[0]!.bytes).toBe(64);
  });

  it("touch updates only lastUsedAt", async () => {
    const store = createMemoryCacheStore();
    await store.put(entryFor("a", 64, 1));
    await store.touch("a", 5000);
    const got = await store.get("a");
    expect(got!.lastUsedAt).toBe(5000);
    expect(got!.createdAt).toBe(1);
    expect(got!.bytes).toBe(64);
    expect(got!.textures).toHaveLength(1);
  });

  it("deletes, clears and estimates", async () => {
    const store = createMemoryCacheStore();
    await store.put(entryFor("a", 64, 1));
    await store.put(entryFor("b", 32, 2));
    expect(await store.estimate!()).toEqual({ entries: 2, bytes: 96 });
    await store.delete("a");
    expect(await store.get("a")).toBeNull();
    await store.clear();
    expect(await store.list()).toEqual([]);
  });

  it("returns null for a missing id", async () => {
    const store = createMemoryCacheStore();
    expect(await store.get("nope")).toBeNull();
  });
});

describe("bake cache policy", () => {
  const key: BakeCacheKey = { id: "k1", key: "canonical:k1" };

  it("touches no storage while disabled", async () => {
    const { store, calls } = countingStore(createMemoryCacheStore());
    const cache = new BakeTextureCache({ store });
    expect(cache.enabled).toBe(false);
    expect(await cache.read(key)).toBeNull();
    await cache.write(key, payload(64));
    expect(cache.canWrite(1000, 64)).toBe(false);
    expect(calls).toEqual({});
  });

  it("writes then reads back, counting hits and misses", async () => {
    const cache = new BakeTextureCache({ store: createMemoryCacheStore(), enabled: true });
    expect(await cache.read(key)).toBeNull(); // miss
    await cache.write(key, payload(64));
    const hit = await cache.read(key);
    expect(hit).not.toBeNull();
    expect(hit!.bytes).toBe(64);
    const metrics = await cache.metrics();
    expect(metrics.hits).toBe(1);
    expect(metrics.misses).toBe(1);
    expect(metrics.writes).toBe(1);
    expect(metrics.entries).toBe(1);
    expect(metrics.bytes).toBe(64);
    expect(metrics.store).toBe("memory");
  });

  // A hash collision must degrade to a miss, never to another document's textures.
  it("rejects an entry whose canonical key disagrees, and drops it", async () => {
    const store = createMemoryCacheStore();
    const cache = new BakeTextureCache({ store, enabled: true });
    await cache.write(key, payload(64));
    const impostor: BakeCacheKey = { id: "k1", key: "canonical:something-else" };
    expect(await cache.read(impostor)).toBeNull();
    const metrics = await cache.metrics();
    expect(metrics.collisions).toBe(1);
    expect(metrics.misses).toBe(1);
    expect(await store.get("k1")).toBeNull(); // the loser is evicted, not re-checked every bake
  });

  // The two size knobs are in DIFFERENT currencies: maxEntryBytes gates the raw capture (it runs before the
  // readback, when the stored size is unknowable), while budgetBytes governs compressed bytes on disk. A
  // default sized against the disk figure silently stopped caching anything above 1024²x7, so pin the raw
  // totals it must admit.
  it("admits realistic full-material captures at the default raw ceiling", () => {
    const cache = new BakeTextureCache({ store: createMemoryCacheStore(), enabled: true, minBakeMs: 0 });
    const raw = (size: number, channels: number) => size * size * 4 * channels;
    expect(cache.canWrite(1000, raw(1024, 7))).toBe(true); //  28 MB
    expect(cache.canWrite(1000, raw(2048, 7))).toBe(true); // 112 MB — the case the old default rejected
    expect(cache.canWrite(1000, raw(4096, 4))).toBe(true); // 256 MB
    expect(cache.canWrite(1000, raw(4096, 7))).toBe(false); // 448 MB — too big a readback to be worth it
  });

  it("refuses oversized entries and cheap bakes", async () => {
    const cache = new BakeTextureCache({
      store: createMemoryCacheStore(),
      enabled: true,
      maxEntryBytes: 100,
      minBakeMs: 250,
    });
    expect(cache.canWrite(1000, 101)).toBe(false); // too big
    expect(cache.canWrite(249, 50)).toBe(false); // too cheap to be worth 50 bytes of disk
    expect(cache.canWrite(250, 100)).toBe(true);
    expect(cache.canWrite(1000, 0)).toBe(false); // nothing to store
    await cache.write(key, payload(101));
    expect((await cache.metrics()).entries).toBe(0);
  });

  it("evicts least-recently-used entries to stay within budget", async () => {
    const store = createMemoryCacheStore();
    // Seed three entries directly with known LRU timestamps, oldest first.
    await store.put(entryFor("old", 40, 1000));
    await store.put(entryFor("mid", 40, 2000));
    await store.put(entryFor("new", 40, 3000));
    const cache = new BakeTextureCache({ store, enabled: true, budgetBytes: 100 });
    expect(await cache.evict()).toBe(1); // 120 > 100, drop exactly one
    const ids = (await cache.entries()).map((m) => m.id).sort();
    expect(ids).toEqual(["mid", "new"]);
    expect((await cache.metrics()).evictions).toBe(1);
  });

  it("makes room before a write instead of overshooting the budget", async () => {
    const store = createMemoryCacheStore();
    await store.put(entryFor("old", 80, 1000));
    const cache = new BakeTextureCache({ store, enabled: true, budgetBytes: 100, minBakeMs: 0 });
    await cache.write(key, payload(64));
    const metrics = await cache.metrics();
    expect(metrics.bytes).toBeLessThanOrEqual(100);
    expect(metrics.entries).toBe(1);
    expect((await cache.entries())[0]!.id).toBe("k1"); // the new entry survives, the stale one went
  });

  it("drops entries written by a different build", async () => {
    const store = createMemoryCacheStore();
    const foreign = entryFor("foreign", 64, 1);
    foreign.schema = "mdbc1.1.4.0.0.1";
    await store.put(foreign);
    await store.put(entryFor("current", 64, 2));
    const cache = new BakeTextureCache({ store, enabled: true });
    expect(await cache.gc()).toBe(1);
    expect((await cache.entries()).map((m) => m.id)).toEqual(["current"]);
  });

  it("never throws when the store fails, and records why", async () => {
    const boom = (): never => {
      throw new Error("disk on fire");
    };
    const broken: BakeCacheStore = {
      name: "broken",
      get: async () => boom(),
      put: async () => boom(),
      touch: async () => boom(),
      delete: async () => boom(),
      list: async () => boom(),
      clear: async () => boom(),
    };
    const cache = new BakeTextureCache({ store: broken, enabled: true });
    // Every one of these would otherwise surface inside bakeInto and turn a cache problem into a broken bake.
    expect(await cache.read({ id: "x", key: "y" })).toBeNull();
    await expect(cache.write({ id: "x", key: "y" }, payload(64))).resolves.toBeUndefined();
    await expect(cache.clear()).resolves.toBeUndefined();
    await expect(cache.delete("x")).resolves.toBeUndefined();
    expect(await cache.entries()).toEqual([]);
    expect(cache.lastError).toContain("disk on fire");
  });

  it("disables itself when the origin stays out of quota", async () => {
    const events: string[] = [];
    const quotaFull: BakeCacheStore = {
      ...createMemoryCacheStore(),
      name: "quota-full",
      put: async () => {
        const err = new Error("quota");
        err.name = "QuotaExceededError";
        throw err;
      },
    };
    const cache = new BakeTextureCache({
      store: quotaFull,
      enabled: true,
      minBakeMs: 0,
      onEvent: (e) => events.push(e.kind),
    });
    await cache.write(key, payload(64));
    expect(cache.enabled).toBe(true); // first failure: evict and retry
    await cache.write(key, payload(64));
    expect(cache.enabled).toBe(false); // second: latch off rather than hammer the disk
    expect(events).toContain("disabled");
  });

  it("survives a throwing event listener", async () => {
    const cache = new BakeTextureCache({
      store: createMemoryCacheStore(),
      enabled: true,
      minBakeMs: 0,
      onEvent: () => {
        throw new Error("listener bug");
      },
    });
    await expect(cache.write(key, payload(64))).resolves.toBeUndefined();
    expect((await cache.metrics()).writes).toBe(1);
  });

  it("peeks metadata without reading texels", async () => {
    const cache = new BakeTextureCache({ store: createMemoryCacheStore(), enabled: true });
    await cache.write(key, payload(64));
    const meta = await cache.peek(key);
    expect(meta!.bytes).toBe(64);
    expect((meta as Partial<BakeCacheEntry>).textures).toBeUndefined();
    // A peek is not a use: it must not inflate the hit counter that measures cache effectiveness.
    expect((await cache.metrics()).hits).toBe(0);
  });

  it("reconfigures at runtime", async () => {
    const cache = new BakeTextureCache({ store: createMemoryCacheStore() });
    expect(cache.enabled).toBe(false); // opt-in: nothing happens until you say so
    // Byte-compressed by default: restores as fast as raw, ~6x smaller on disk, and unlike PNG it costs
    // nothing at restore time because there is no image to decode.
    expect(cache.encoding).toBe("deflate");
    expect(cache.storeName).toBe("memory"); // a consumer-supplied store is never swapped out
    cache.configure({ encoding: "png", budgetBytes: 1, enabled: true, namespace: "ns" });
    expect(cache.encoding).toBe("png");
    expect(cache.storeName).toBe("memory");
    expect(cache.namespace).toBe("ns");
    expect(cache.enabled).toBe(true);
    cache.setEnabled(false);
    expect(cache.enabled).toBe(false);
  });
});
