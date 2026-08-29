# material-designer-runtime

Lightweight runtime for loading Material Designer node graph documents and applying them to Three.js meshes.

## Install

```sh
npm install material-designer-runtime three@0.184.0
```

`three` is a peer dependency — this package uses its WebGPU renderer and TSL, so install the exact
supported version alongside it.

## Usage

There are two ways to put a document's material on a mesh: let the runtime hand you a
**ready-made material** (all config loaded for you), or bake the **channel textures** and assign
them to a material you build yourself. Everything bakes on a `WebGPURenderer`, which must be
initialized (`await renderer.init()`) first.

### Get a ready-made material

`getNodeMaterial()` and `getMeshMaterial()` both load the document's family and every setting
(metalness, roughness, the physical lobes, phong shininess, toon gradient, …) — you never copy
config by hand. Pick based on what you need:

- **`getNodeMaterial()`** — the TSL node material (`MeshStandardNodeMaterial`, `MeshPhysicalNodeMaterial`, …)
  with full procedural fidelity: triplanar projection, parallax-occlusion, per-vertex AO, and
  procedurally-driven lobes. WebGPU only.
- **`getMeshMaterial()`** — a plain Three.js material (`MeshStandardMaterial`, `MeshPhysicalMaterial`,
  `MeshLambertMaterial`, `MeshToonMaterial`, `MeshPhongMaterial`, `MeshMatcapMaterial`) with the baked
  maps in the standard slots. Drops the node-only features above.

```ts
import { MaterialGraphRuntime } from "material-designer-runtime";
import { WebGPURenderer } from "three/webgpu";
import { Mesh, SphereGeometry } from "three";

const renderer = new WebGPURenderer();
await renderer.init();

const runtime = new MaterialGraphRuntime()
  .setRenderer(renderer)
  .fromDocument(document);
await runtime.refresh(); // bake the graph to channel textures

const geometry = new SphereGeometry(1, 128, 64);

// (a) TSL node material — full fidelity (triplanar, parallax, procedural lobes), WebGPU only:
const mesh = new Mesh(geometry, runtime.getNodeMaterial());
// The node material object can change on a re-bake (e.g. a family switch) — keep the mesh current:
runtime.surface.onRebuilt(() => { mesh.material = runtime.getNodeMaterial(); });

// (b) …or a plain Three.js material with the baked maps + settings loaded in (pick one path):
//   geometry.setAttribute("uv1", geometry.getAttribute("uv")); // .aoMap samples the 2nd UV set
//   const mesh = new Mesh(geometry, runtime.getMeshMaterial());

// Live edits re-bake implicitly — await whenIdle() before reading back:
runtime.setNodeParam("noise", "scale", 18);
runtime.setOutputResolution(1024);
await runtime.whenIdle();

runtime.dispose(); // release GPU resources when done
```

### Bring your own material

Bake just the PBR channel maps with the shared `bakeService` (no material surface is created) and
assign them to your own material. The baked textures already carry the correct `.colorSpace`
(base color / emission are sRGB, data channels linear), so you assign them as-is:

```ts
import { bakeService, MaterialGraphSession, defaultRegistry } from "material-designer-runtime";
import { WebGPURenderer } from "three/webgpu";
import { Mesh, BoxGeometry, MeshStandardMaterial } from "three";

const renderer = new WebGPURenderer();
await renderer.init();
bakeService.attachRenderer(renderer);

const session = new MaterialGraphSession(document, defaultRegistry);
const set = await bakeService.bake(session, { size: 1024 }); // set.present = the channels actually baked

const material = new MeshStandardMaterial();
material.map = set.texture("baseColor"); // THREE.Texture | null, keyed by channel
material.roughnessMap = set.texture("roughness");
material.metalnessMap = set.texture("metallic");
material.normalMap = set.texture("normal");
material.aoMap = set.texture("ambientOcclusion");
material.emissiveMap = set.texture("emission");
material.emissive.set(0xffffff);
material.roughness = 1;
material.metalness = 1; // the maps carry the values — keep the multipliers at 1

const geometry = new BoxGeometry(1, 1, 1);
geometry.setAttribute("uv1", geometry.getAttribute("uv")); // aoMap samples the 2nd UV set
const mesh = new Mesh(geometry, material);
// Keep `set` alive while the material is in use — set.dispose() frees the render targets (and the textures).
```

`height` is baked separately (`set.heightTarget?.texture`). To read a channel back as CPU pixels
for PNG export, use `bakeService.readImage(session, channel, 1024)` → `ImageData` (size must be a
multiple of 64). If you keep a live `MaterialGraphRuntime`, the same baked textures are also
reachable via `runtime.surface.getChannelTexture(channel)` and `runtime.surface.getHeightTexture()`.

## Opt-in profiling

Profiling is a separate package entry and is not reachable from the production runtime bundle. Import it
only in a benchmark or development surface:

```ts
import { MaterialBakeService } from "material-designer-runtime";
import { profileMaterialNodes } from "material-designer-runtime/profiling";

const service = new MaterialBakeService();
service.attachRenderer(renderer);
const report = await profileMaterialNodes(service, session, {
  size: 512,
  runs: 5,
  logCompiledShaders: true,
});
```

The `/profiling` entry owns timestamp queries, shader inspection, workload accounting, matched-baseline
compiles, and cold shader identities. None of those modules are imported by `material-designer-runtime`.
`logCompiledShaders` adds collapsed console groups for each output's actual compiled Three material, timing
values, and complete vertex/fragment WGSL; it is disabled unless requested.

## Persistent texture cache (opt-in)

Baking is dominated by **shader compilation**, not rendering — on a heavy graph the pipeline compile runs
into seconds while the render is tens of milliseconds. Without a cache that cost is paid again on every page
load, even when the document hasn't changed by a single texel.

The cache stores the baked channel texels and, on a hit, restores them with a GPU-to-GPU copy that
short-circuits **before** the compile. It is **off by default** — enabling it is the only way anything is
persisted:

```ts
const runtime = new MaterialGraphRuntime({ document, cache: {} }); // {} = defaults, enabled
// …or turn it on later:
runtime.setCacheEnabled(true);
```

Everything you need:

```ts
runtime.cacheEnabled;                      // is it on?
runtime.setCacheEnabled(true | false);     // toggle (installs the default cache on first enable)
await runtime.clearCache();                // drop every cached bake
await runtime.rebuildCache();              // re-bake for real and replace this document's entry,
                                           //   resolving only once the new entry is durably written
await runtime.getCachedTextures();         // this document's entry metadata, or null
await runtime.listCachedTextures();        // every entry's metadata, newest use first
await runtime.loadCachedChannelTextures(); // …or the actual textures (see below)
await runtime.cacheMetrics();              // size taken + hit/miss/evict counters
await runtime.flushCache();                // force the deferred write now (e.g. on unload)
```

`cacheMetrics()` answers "how much space is this taking":

```ts
{ enabled, available, store: "worker-indexeddb", encoding: "png",
  entries, bytes,            // bytes AS STORED (post-compression) — the real footprint
  budgetBytes,               // LRU-evicted down to this
  hits, misses, writes, evictions, collisions,
  quota: { usage, quota },   // navigator.storage.estimate(), where the browser reports it
  lastError }
```

### Configuration

```ts
new MaterialGraphRuntime({ document, cache: {
  enabled: true,
  store: myStore,           // bring your own (see below); default is worker+IndexedDB
  encoding: "deflate",      // or "rgba8" (cheaper saves) / "png" (smallest, slower restores)
  budgetBytes: 256 * 2 ** 20,   // on-disk ceiling, in STORED (compressed) bytes
  maxEntryBytes: 256 * 2 ** 20, // per-capture ceiling, in RAW texel bytes — see note below
  minBakeMs: 250,           // don't spend disk to save a bake cheaper than this
  writeDelayMs: 750,        // quiet period before the capture runs
  worker: true,             // false = main thread; { url } = self-hosted worker (strict CSP)
  namespace: "my-app",      // your own invalidation lever
  onEvent: (e) => {},       // hit | miss | write | evict | collision | disabled | error
}});
```

The codec and all storage IO run **in a worker**, so neither encoding nor IO touches the main thread. Only the
GPU readback is main-thread (it has to be), and it is deferred past `writeDelayMs`, skipped when an entry
already exists, and collapsed to one capture per burst of re-bakes.

**On `encoding`.** All three options are lossless; they trade save cost against footprint.

- `"deflate"` (default) — byte compression, no image codec. Restores as fast as raw texels, and stores about
  6× smaller. Saving costs real CPU, but it runs in the worker and does not hold the bake queue, so nothing
  waits on it.
- `"rgba8"` — raw texels. Cheapest to save, largest on disk.
- `"png"` — smallest footprint, but measurably slower to restore: unpacking an image is real work, and a
  cache exists to make the second load fast.

Footprint matters more than it first looks. Raw texels run ~80 MB per material at 2048², so the default
256 MB budget would hold roughly three materials before evicting; compressed it holds around eighteen. That is
the difference between a cache that accumulates and one that thrashes.

Lossy GPU formats (KTX2/Basis) are deliberately not offered. This cache must reproduce a bake *exactly* —
otherwise you would author a material against one image and get a different one back on reload — and block
compression visibly damages the data channels, normals worst of all. It would also buy nothing here: a restore
writes into the same render targets the baker draws into, and those are uncompressed by construction.

**The two size knobs are in different currencies.** `budgetBytes` is compressed bytes on disk.
`maxEntryBytes` is *raw* texel bytes, because it gates the capture before the readback — at which point the
stored size can't be known. Size it against raw totals:

| bake size | 1 channel | 7 channels (raw) |
| --- | --- | --- |
| 512²  | 1 MB  | 7 MB |
| 1024² | 4 MB  | 28 MB |
| 2048² | 16 MB | 112 MB |
| 4096² | 64 MB | 448 MB |

PNG typically shrinks that by 10× or more, so if you set `maxEntryBytes` to the on-disk figure you have in
mind, larger materials will silently stop being cached.

### What a capture costs

The readback is the one part that runs on the main thread. Measured on an M-series Mac in Chrome, per
channel, median of 12 runs:

| bake size | GPU→CPU read | row flip (JS) | total | ×7 channels |
| --- | --- | --- | --- | --- |
| 512²  | 1.0 ms  | 0.2 ms | 1.2 ms  | ~8 ms |
| 1024² | 2.4 ms  | 0.6 ms | 3.0 ms  | ~21 ms |
| 2048² | 6.3 ms  | 2.4 ms | 8.7 ms  | ~61 ms |
| 4096² | 22.3 ms | 9.9 ms | 32.2 ms | ~225 ms |

Roughly linear in bytes (~0.35 ms/MB transfer, ~0.15 ms/MB flip). This is why the capture is deferred rather
than run inline at the end of a bake: it is work that only pays off on the *next* load, so making the current
one wait for it would be paying now for a benefit later. De-padding is free at bake sizes that are multiples
of 64 (the rows arrive tightly packed), which every surface bake is.

### Bring your own storage

Implement `BakeCacheStore` and the runtime uses it instead of IndexedDB — for a server, a CDN, your own
database, or node's filesystem:

```ts
import { BakeTextureCache, type BakeCacheStore } from "material-designer-runtime";

const store: BakeCacheStore = {
  name: "my-backend",
  async get(id) { … }, async put(entry) { … },
  async touch(id, lastUsedAt) { … },   // must NOT rewrite the texels — runs on every hit
  async delete(id) { … },
  async list() { … },                  // metadata ONLY, never texels
  async clear() { … },
};
runtime.service.setCache(new BakeTextureCache({ enabled: true, store }));
```

Texels cross this interface as tightly-packed, top-down RGBA8; compress internally if you like, but decode
before returning, and overwrite `meta.bytes` with the size you actually stored so the metrics stay truthful.
`createBakeCacheKey(...)` (also `runtime.cacheKey()`) is exported, so you can key your own cache identically.

### Using cached textures directly

`loadCachedChannelTextures()` needs **no renderer** — a page shipping a fixed material can dress a plain
THREE material from cache without ever compiling a shader:

```ts
const cached = await runtime.loadCachedChannelTextures();
if (cached) {
  const material = buildMeshMaterial(runtime.getDocument(), cached);
  // …you own these textures: cached.dispose() when the material is done with them.
}
```

### Notes

- **Invalidation is automatic.** The key covers the graph topology, every effective param value (registry
  defaults merged in, so a sparse document keys the same as an explicit one), bake size, channel set, document
  schema version, three's revision, and this package's version — the last because node maths changes texel
  output without a schema bump. An upgrade therefore starts cold rather than restoring stale texels.
  Cosmetics (node labels, positions, pan/zoom, metadata) never invalidate.
- **A cache failure can never break a bake.** Every storage call is contained; a miss, a corrupt record, a
  dead worker, or an exhausted quota all fall through to baking normally.
- **The first edit after a hit costs one full rebuild.** A restore deliberately skips compilation, so there are
  no compiled materials to re-render with until the next rebuild repopulates them.
- **It is a binary store, so `localStorage.clear()` will not touch it.** If your app has a "reset everything"
  path, call `clearCache()` there too; `BAKE_CACHE_DB_NAME` is exported if you'd rather delete the database.

The editor owns UI state, selection, presets, and undo history. This package owns graph document loading,
compilation, baking, direct parameter updates, the material surface, and — opt-in — a cache of its own bake
artifacts. That last one is the single exception to "the editor owns storage": it caches only what this package
produces, it is off unless you enable it, and `cache.store` hands storage ownership back to you whenever you
want it.
