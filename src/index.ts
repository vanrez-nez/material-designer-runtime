export {
  MaterialGraphRuntime,
  type CachedChannelTextures,
  type MaterialGraphRuntimeOptions,
} from "./runtime";
export {
  MATERIAL_DOCUMENT_VERSION,
  MaterialGraphSession,
  cloneMaterialDocument,
  createDefaultMaterialDocument,
  migrateMaterialDocument,
} from "./document";
export { MATERIAL_RUNTIME_VERSION } from "./version";
export { canonicalStringify, createMaterialParamKey, createMaterialTopologyKey } from "./topology";
export * from "./cache";

export {
  MaterialBakeService,
  BakedTextureSet,
  SURFACE_CHANNELS,
  bakeService,
  type BakeOptions,
  type BakeReport,
  type BakeTimingBreakdown,
} from "./graph/bake-service";
export {
  type NodeProfileOptions,
  type NodeProfileReport,
  type NodeProfileRow,
  type NodeProfileShaderMetrics,
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
  channelByteLength,
  channelDataTexture,
  depadRows,
  disposeTransferPool,
  flipRows,
  paddedBytesPerRow,
  readTargetTexels,
  transferPoolInfo,
  writeTargetTexels,
} from "./graph/texture-transfer";
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
