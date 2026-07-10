export { MaterialGraphRuntime, type MaterialGraphRuntimeOptions } from "./runtime";
export {
  MATERIAL_DOCUMENT_VERSION,
  MaterialGraphSession,
  cloneMaterialDocument,
  createDefaultMaterialDocument,
  migrateMaterialDocument,
} from "./document";
export { createMaterialTopologyKey } from "./topology";

export {
  MaterialBakeService,
  BakedTextureSet,
  SURFACE_CHANNELS,
  bakeService,
  type BakeOptions,
  type BakeReport,
} from "./graph/bake-service";
export {
  type NodeProfileOptions,
  type NodeProfileReport,
  type NodeProfileRow,
} from "./graph/node-profiler";
export {
  compileGraph,
  compileSockets,
  countGraphNodes,
  newSurfaceMaterial,
  readMaterialSurface,
  readMaterialConfig,
  readOutputResolution,
  type CompileOptions,
  type CompiledSockets,
  type MaterialConfig,
} from "./graph/compiler";
export { buildMeshMaterial, type ChannelTextures } from "./graph/mesh-material";
export {
  NodeRegistry,
  createDefaultRegistry,
  defaultRegistry,
  nodeParamDefs,
  nodePorts,
} from "./graph/registry";
export { TexturedSurface } from "./graph/textured-surface";
export { runTilingTest } from "./graph/tiling-test";
export * from "./graph/types";
