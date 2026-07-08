import { vec3 } from "three/tsl";
import type { MaterialNodeDef, MaterialValue } from "../../types";
import { rotateAxis } from "../../../tsl/vector-rotate";

type V = MaterialValue;
const AXES = ["x", "y", "z"];

// Vector Rotate (Blender ShaderNodeVectorRotate — axis modes). Rotates `vector` around `center` by `angle`
// (radians) about a principal axis. `angle` is a float input, so it can vary per fragment — feed it a
// per-cell random (e.g. Tile Generator's cellRandom) to give every cell its own orientation. `vector`
// defaults to the global coordinate and `center` to the origin when unconnected; `angle` falls back to the
// param when its input is unconnected. Pure transform — does not affect tiling (see tsl/vector-rotate.ts).
export const vectorRotateNode: MaterialNodeDef = {
  type: "vector-rotate",
  nodeClass: "vector",
  label: "Vector Rotate",
  inputs: [
    { key: "vector", kind: "vector" },
    { key: "center", kind: "vector" },
    { key: "angle", kind: "float" },
  ],
  outputs: [{ key: "vector", kind: "vector" }],
  params: [
    { key: "axis", label: "axis", type: "select", options: AXES, default: "z" },
    { key: "angle", label: "angle", type: "float", min: -6.283185, max: 6.283185, step: 0.01, default: 0 },
  ],
  build(ctx) {
    const v = (ctx.inputs.vector ?? ctx.coord) as V;
    const center = (ctx.inputs.center ?? vec3(0, 0, 0)) as V;
    const angle = (ctx.inputs.angle ?? ctx.live("angle")) as V;
    const axis = Math.max(0, AXES.indexOf(ctx.constant("axis") as string));
    return { vector: rotateAxis(v, center, angle, axis) };
  },
};
