import type { MaterialNodeDef } from "../../types";

// Composite (node group) types — Blender's node groups (plan L7 / Phase 5). Their ports are
// instance-specific (carried on GraphNode.ports / derived from the group's interface), so the static
// inputs/outputs here are empty. The compiler handles them specially: it compiles a group's nested
// `subgraph`, seeds the Group Input node with the group's external inputs, and reads the Group Output
// node's inputs back as the group's outputs. build() is never called for these (returns {}).

// A group instance — owns a nested document (node.subgraph) and exposes its interface as ports.
// Cache bake resolution is NOT a group setting: the compiler auto-supersamples a group's decomposition cache
// when its output is on a derivative (Normal From Height) path — see compiler.ts / MaterialNodeDef.bakeDerivative.
// build() is never called for groups.
export const groupNode: MaterialNodeDef = {
  type: "group",
  nodeClass: "group",
  label: "Group",
  inputs: [],
  outputs: [],
  params: [],
  build() {
    return {};
  },
};

// Subgraph boundary: its outputs are the group's external inputs (fed in from the parent).
export const groupInputNode: MaterialNodeDef = {
  type: "group-input",
  nodeClass: "input",
  label: "Group Input",
  inputs: [],
  outputs: [],
  params: [],
  build() {
    return {};
  },
};

// Subgraph boundary: its inputs become the group's external outputs.
export const groupOutputNode: MaterialNodeDef = {
  type: "group-output",
  nodeClass: "output",
  label: "Group Output",
  inputs: [],
  outputs: [],
  params: [],
  build() {
    return {};
  },
};
