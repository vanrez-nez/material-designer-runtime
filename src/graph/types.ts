// Generic composable material graph — core types (material-graph-plan.md).
//
// A MaterialGraphDocument is a serializable, id-based DAG of typed nodes. Each node type is described
// by a MaterialNodeDef in the registry, whose build() emits TSL node-values per output. The compiler
// (compiler.ts) topo-sorts the document, resolves the Principled BSDF feeding the terminal
// `material-output` node, and unpacks its bundle into a MeshPhysicalNodeMaterial (live node sockets) or
// convertToTexture-baked maps.

// TSL node-values are dynamically typed: DefinitelyTyped's TSL coverage is partial and the
// ShaderNodeObject<T> variance is awkward to thread through generic graph boundaries. A documented
// alias keeps the boundary honest without fighting the type system at every edge; build() internals
// stay precise because the TSL functions they call are themselves typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MaterialValue = any;

// Port kinds map onto TSL value types, mirroring Blender's shader-relevant socket types + colours:
//   float  -> TSL float    (grey:   scalars — height, masks, roughness, AO, metallic)
//   vector -> TSL vec2/3   (blue:   coordinate domains, warp offsets, flow fields, normals)
//   color  -> TSL vec3     (yellow: sRGB-authored colour — basecolor, emission)
// `field` was renamed to `float`; `normal` was folded into `vector` — Blender has no separate normal
// socket type, a normal is just a Vector with semantics (blender-node-alignment-plan.md L3).
// `shader` (green) is the constrained BSDF-closure marker: only Principled BSDF / Emission emit it and
// only Material Output consumes it (TSL has no real closure type — plan L1). It carries a MaterialBundle,
// never a TSL value, and never coerces to/from another kind.
export type PortKind = "float" | "vector" | "color" | "shader";

export interface PortDef {
  key: string;
  label?: string;
  kind: PortKind;
}

// Blender node classes (nclass). Drives Add-menu grouping and node-header colour (consumed in Phase 1).
// Grounded subset from blender-node-alignment-plan.md §4.
export type NodeClass =
  | "input"
  | "output"
  | "shader"
  | "texture"
  | "color"
  | "vector"
  | "converter"
  | "group";

export type ParamType = "float" | "int" | "bool" | "color" | "select" | "vec3" | "curve";

// A vec3 param value (location/rotation/scale on the Mapping node). Serialized as plain {x,y,z}.
export interface Vec3Value {
  x: number;
  y: number;
  z: number;
}

// A `curve` param value: four tone curves (RGB Curves node). Each channel is the list of control-point
// y-values at fixed x = 0, .25, .5, .75, 1 (curve5). C is the combined curve applied to all channels
// first, then the per-channel R/G/B curves. Identity default = [0, .25, .5, .75, 1]. Serialized as plain
// JSON. Drives a `uniformArray` of 20 floats so curve edits update live without recompiling.
export interface CurveValue {
  C: number[];
  R: number[];
  G: number[];
  B: number[];
}
export const CURVE_IDENTITY: readonly number[] = [0, 0.25, 0.5, 0.75, 1];
export const CURVE_CHANNELS = ["C", "R", "G", "B"] as const;

// Flatten a curve value to the 20-float uniform-array layout [C0..C4, R0..R4, G0..G4, B0..B4], filling
// in the identity ramp for any missing/short channel. Used by both the compiler (uniform seed) and the
// controller's live update so the two never disagree on ordering.
export function curveToArray(v: CurveValue | undefined): number[] {
  const ch = (a: number[] | undefined): number[] =>
    Array.from({ length: 5 }, (_, i) => a?.[i] ?? CURVE_IDENTITY[i]);
  return [...ch(v?.C), ...ch(v?.R), ...ch(v?.G), ...ch(v?.B)];
}

export interface ParamDef {
  key: string;
  label: string;
  type: ParamType;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  default: unknown;
  // True for a float/colour param the OFFLINE bake reads at build time (baked into the shader / CPU
  // precompute) rather than as a live uniform — e.g. Voronoi `scale` (→ integer period), Voronoi
  // `randomness` (relaxed seed precompute), Tileable Noise `aspect`. Changing it must recompile the offline
  // bake, so the surface's offline uniform fast-path skips it and re-bakes. (In the LIVE backend such params
  // may still be real uniforms; that path is unaffected.)
  bakeStructural?: boolean;
}

// live  = procedural node material over positionWorld (seamless 3D field; a power/debug toggle).
// offline = the node graph is baked to textures; the surface samples them (triplanar) + stock PBR. Default.
export type MaterialBackend = "live" | "offline";

export type GraphChange =
  | { kind: "structural" }
  | {
      kind: "param";
      nodeId: string;
      key: string;
      paramType: ParamType;
      value: unknown;
      bakeStructural?: boolean;
    };

export interface BuildCtx {
  // Resolved upstream TSL node-values keyed by this node's input port key (undefined if unconnected).
  inputs: Record<string, MaterialValue | undefined>;
  // Live-tweakable params as TSL uniform nodes (float / int / color). Updating `.value` re-renders
  // without recompiling.
  uniforms: Record<string, MaterialValue>;
  // Raw param values, for build-time branching (bool/select) and loop counts (octaves) that cannot be
  // dynamic uniforms.
  params: Record<string, unknown>;
  // The coordinate domain: positionWorld (live, 3D seamless) or vec3(uv, 0) (offline, 2D tileable bake).
  coord: MaterialValue;
  backend: MaterialBackend;
  // Offline tiling (repeating-unit model, see compiler maybeTileNode): when a `bakeTileable` node has its
  // `tileSize` set, the compiler renders a REPEATING BLOCK — the noise renders `period / tileRepeat` periods
  // into a tileSize² buffer that then repeats `tileRepeat` times to fill the texture. A node that supports
  // tiling divides its period by this factor so the total feature count (feature size) stays constant while
  // the block repeats. 1 (default) = no tiling / not applicable.
  tileRepeat?: number;
}

export interface MaterialNodeDef {
  type: string;
  nodeClass: NodeClass;
  label: string;
  // Static port interface. For mode-driven nodes whose ports depend on a param (e.g. Voronoi's feature),
  // provide `declare(params)` instead — it overrides these. `inputs`/`outputs` should then list the
  // default-param interface (used for fallbacks / palette). Resolved everywhere via registry.nodePorts.
  inputs: PortDef[];
  outputs: PortDef[];
  params: ParamDef[];
  // Optional dynamic socket declaration (Blender's declare()): compute the node's ports from its current
  // params. When present, a param change can add/remove sockets — the controller prunes now-dangling
  // edges and the editor reconciles. See plan L7 / Phase 5.
  declare?(params: Record<string, unknown>): { inputs: PortDef[]; outputs: PortDef[] };
  // Optional CONTEXT-SENSITIVE param list (the param-level parallel of declare): given the node's current
  // params, return only the ParamDefs that actually take effect — so the editor hides controls that do nothing
  // in the current mode (e.g. Tileable Noise `aspect` off cellular types; Voronoi `exponent` off Minkowski).
  // A subset of `params` (same objects, order preserved). Resolved via registry.nodeParamDefs. This is a
  // UI-ONLY filter: the compiler still builds uniforms from the full `params`, so a hidden param keeps working
  // if the build path (or the live fallback) references it. Absent → all `params`.
  paramsFor?(params: Record<string, unknown>): ParamDef[];
  // Marks a node that takes a SCREEN-SPACE DERIVATIVE of its input (e.g. Normal From Height's dFdx/dFdy).
  // The offline baker must render any decomposition cache on a derivative's dependency path SUPERSAMPLED, so
  // the derivative is computed on a finer grid than the target and averaged down (otherwise fine height
  // detail aliases into per-texel speckle). See compiler.ts auto-supersample + channel-baker SS.
  bakeDerivative?: boolean;
  // Marks a node whose (periodic) output the offline baker may render into a small seamless tile ONCE and
  // repeat, when its `tileSize` param is set — an individual node becomes a decomposition-cache boundary so
  // the expensive per-texel eval (noise) runs at tileSize² instead of the full grid. See compiler.ts tiling.
  bakeTileable?: boolean;
  // Emit one TSL node-value per output port key. The terminal `material-output` returns {} — the compiler
  // reads its connected inputs directly.
  build(ctx: BuildCtx): Record<string, MaterialValue>;
}

export interface GraphNode {
  id: string;
  type: string;
  params: Record<string, unknown>;
  position: { x: number; y: number };
  enabled: boolean;
  // Optional user-facing name; overrides the registry def.label in the editor (title + breadcrumb).
  // Cosmetic only — the compiler ignores it, so renames never recompile. Additive/optional: documents
  // without it load fine (no DOC_VERSION bump).
  label?: string;
  // Instance-specific ports — set only on group / group-input / group-output nodes, whose interface is
  // defined per instance rather than by a static MaterialNodeDef. Resolved via nodePorts() in registry.ts.
  ports?: { inputs: PortDef[]; outputs: PortDef[] };
  // A group node owns a nested document (Blender's node group). Compiled recursively by the compiler.
  subgraph?: MaterialGraphDocument;
}

// Node-type ids for the composite (group) system. group-input / group-output are the subgraph boundary
// markers (Blender's Group Input / Group Output). See plan L7 / Phase 5.
export const GROUP_TYPE = "group";
export const GROUP_INPUT_TYPE = "group-input";
export const GROUP_OUTPUT_TYPE = "group-output";

export interface GraphEdge {
  fromNode: string;
  fromOutput: string;
  toNode: string;
  toInput: string;
}

export interface MaterialGraphDocument {
  version: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface MaterialGraphSource {
  readonly document: MaterialGraphDocument;
  readonly lastError: string | null;
  readonly soloNode: string | null;
  compileBundle(opts: import("./compiler").CompileOptions): import("./compiler").CompiledSockets;
  getRegistry(): import("./registry").NodeRegistry;
  onChange(fn: (change: GraphChange) => void): () => void;
}

// The terminal node (Blender's Material Output). Exactly one per graph; consumes a single shader marker.
export const MATERIAL_OUTPUT_TYPE = "material-output";

// PBR channels the previews / channel-baker can render. Internal keys; `baseColor` shows as
// "Albedo / Diffuse". These are a subset of the Principled BSDF inputs the compiler unpacks.
export const PBR_SOCKETS = [
  "baseColor",
  "normal",
  "emission",
  "roughness",
  "metallic",
  "ambientOcclusion",
] as const;
export type PbrSocket = (typeof PBR_SOCKETS)[number];

// What a shader node (Principled BSDF / Emission) bundles for Material Output, carried as the
// `shader`-kind value — a plain object, since TSL has no closure type (plan L1). The compiler unpacks it
// onto MeshPhysicalNodeMaterial channels. Fields are undefined when inactive (left at the renderer
// default) so unused physical lobes (coat/sheen/transmission) don't get enabled.
export interface MaterialBundle {
  baseColor?: MaterialValue;
  metallic?: MaterialValue;
  roughness?: MaterialValue;
  ior?: MaterialValue;
  alpha?: MaterialValue;
  normal?: MaterialValue;
  // Scalar height field (white = raised). Offline-only: baked to its own map and consumed by the surface's
  // parallax-occlusion step — never a lit PBR channel. Undefined → no parallax (flat sampling).
  height?: MaterialValue;
  ambientOcclusion?: MaterialValue;
  emission?: MaterialValue;
  coat?: MaterialValue;
  coatRoughness?: MaterialValue;
  sheen?: MaterialValue;
  sheenRoughness?: MaterialValue;
  transmission?: MaterialValue;
}

// --- Permissive type coercion (Blender-like) -------------------------------------------------------
// Maps an (output kind → input kind) pair to the conversion injected at build time. Same-kind pairs are
// "identity"; listed cross-kind pairs are allowed and coerced; unlisted pairs are rejected on connect.
// Consumed in Phase 2 (controller.connect veto, compiler.validate, build-time injection) — data only
// for now. `shader`, when added, is intentionally absent here → never coercible. See plan L6.
export type Coercion =
  | "identity"
  | "float-to-vector" // broadcast x → (x, x, x)
  | "float-to-color" //  broadcast x → (x, x, x)
  | "vector-to-float" // average of components
  | "vector-to-color" // reinterpret xyz → rgb
  | "color-to-float" //  luminance (rgb → bw)
  | "color-to-vector"; // reinterpret rgb → xyz

export const COERCION_MATRIX: Record<PortKind, Partial<Record<PortKind, Coercion>>> = {
  float: { float: "identity", vector: "float-to-vector", color: "float-to-color" },
  vector: { vector: "identity", float: "vector-to-float", color: "vector-to-color" },
  color: { color: "identity", float: "color-to-float", vector: "color-to-vector" },
  // shader only connects shader→shader (Principled/Emission → Material Output); no cross-kind row, so
  // every float/vector/color → shader (and shader → them) is rejected. Plan L1/L6.
  shader: { shader: "identity" },
};

// How (or whether) an output kind may feed an input kind. undefined → reject the connection.
export function coercionFor(from: PortKind, to: PortKind): Coercion | undefined {
  return COERCION_MATRIX[from]?.[to];
}
