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
  .setBackend("offline")
  .fromDocument(document);

await runtime.refresh();
mesh.material = runtime.material;

runtime.setOutputResolution(1024);
runtime.setNodeParam("noise", "scale", 18);
```

The editor owns UI state, selection, storage, presets, and undo history. This package owns only graph document loading, compilation, baking, direct parameter updates, and the material surface.
