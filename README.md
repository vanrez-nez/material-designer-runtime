# material-designer-runtime

Lightweight runtime for loading Material Designer node graph documents and applying them to Three.js meshes.

## Install

```sh
npm install material-designer-runtime three@0.184.0
```

`three` is a peer dependency — this package uses its WebGPU renderer and TSL, so install the exact
supported version alongside it.

## Usage

```ts
import { MaterialGraphRuntime } from "material-designer-runtime";

const runtime = new MaterialGraphRuntime()
  .setRenderer(renderer)
  .fromDocument(document);

await runtime.refresh(); // bake the graph to channel textures
mesh.material = runtime.material; // the exact Three.js material the document describes

// Live edits trigger an implicit re-bake — await whenIdle() before using the result
runtime.setNodeParam("noise", "scale", 18);
runtime.setOutputResolution(1024);
await runtime.whenIdle();

runtime.dispose(); // release GPU resources when done
```

The graph document carries not just the procedural channels (base color, roughness, metallic, normal, …) but also the material family and its settings, so `runtime.material` reconstructs the exact Three.js material — `MeshStandardMaterial`, `MeshPhysicalMaterial`, `MeshLambertMaterial`, `MeshToonMaterial`, `MeshPhongMaterial`, or `MeshMatcapMaterial`.

The editor owns UI state, selection, storage, presets, and undo history. This package owns only graph document loading, compilation, baking, direct parameter updates, and the material surface.
