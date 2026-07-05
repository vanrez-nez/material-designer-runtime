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

The editor owns UI state, selection, storage, presets, and undo history. This package owns only graph document loading, compilation, baking, direct parameter updates, and the material surface.
