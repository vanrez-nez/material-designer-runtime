import * as THREE from "three";
import {
  MeshStandardNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshLambertNodeMaterial,
  MeshToonNodeMaterial,
  MeshPhongNodeMaterial,
  MeshMatcapNodeMaterial,
  type NodeMaterial,
} from "three/webgpu";
import { positionWorld, uv, vec3, float, uniform, uniformArray, luminance, attribute, texture } from "three/tsl";
import {
  GROUP_INPUT_TYPE,
  GROUP_OUTPUT_TYPE,
  GROUP_TYPE,
  MATERIAL_OUTPUT_TYPE,
  MATERIAL_TYPE_CAPS,
  SHADER_MATERIAL_TYPE,
  coercionFor,
  curveToArray,
  normalizeMaterialType,
  type CurveValue,
  type BuildCtx,
  type Coercion,
  type GraphNode,
  type MaterialBackend,
  type MaterialBundle,
  type MaterialGraphDocument,
  type MaterialNodeDef,
  type MaterialType,
  type MaterialTypeSettings,
  type MaterialValue,
  type PortKind,
} from "./types";
import { nodePorts, type NodeRegistry } from "./registry";
import { gradientMapFor, matcapFor } from "./material-textures";

// Re-exported so consumers importing from the compiler keep working; the source of truth is material-textures.
export { gradientMapFor, matcapFor };

export interface CompiledMaterial {
  // Any of the six stock node materials (chosen by the graph's materialType); widened from
  // MeshStandardNodeMaterial now that the family is document-driven. Consumers assign it to mesh.material.
  material: NodeMaterial;
  // Per-node param uniforms (nodeId -> { paramKey -> uniform node }), so the editor can live-tweak.
  uniforms: Map<string, Record<string, MaterialValue>>;
}

// How big to allocate/render a decomposition cache. `minSize` is a pixel FLOOR: the cache renders at least this
// big regardless of the (smaller) output resolution — used for the derivative (normal) path so its dFdx grid,
// and the height detail it differentiates, stay at a fixed reference resolution and downsample faithfully (see
// DERIVATIVE_REFERENCE). `size` is an ABSOLUTE px size (a tiled noise's small tile). At most one is set; `size`
// wins. Undefined/empty → the plain bake size. The bake service turns this into the concrete, capped pixel size
// (see cacheSizeFor). A cache with `minSize` set is also mipmapped, so consumers at a lower resolution sample an
// area-averaged mip (a true downsample) instead of aliasing a bilinear tap.
export interface CacheSizing {
  minSize?: number;
  size?: number;
}

// Provider that hands the compiler a persistent cache texture for a decomposed output (offline bake only). The
// bake service owns the render targets; the compiler builds a `texture(...)` sample against the returned
// texture and records the value to bake into it (see CacheEntry).
export type CacheAlloc = (cacheId: string, kind: PortKind, sizing?: CacheSizing) => THREE.Texture;

// Node↔pipeline param contract (see memory: node-param-contract). A node's build() declares each param's
// update category by which accessor it calls on ctx; the compiler records it here and the surface routes
// edits off it (no bakeStructural flag). "live" = a GPU uniform (edit updates .value, no recompile);
// "constant" = consumed at build time (edit re-runs build()).
export type ParamUsage = Map<string, Record<string, "live" | "constant">>;
// Retention store for ctx.constantArray: hands back a pipeline-OWNED uniformArray kept across bakes so a
// same-length content change uploads in place (three reuses node-builder state on an unchanged cache key;
// mutating the retained node's .array is what actually re-uploads). Injected by the bake service.
export type ConstantArrayAlloc = (
  nodeId: string,
  key: string,
  data: ArrayLike<number>,
  elementType: "float" | "vec3",
) => MaterialValue;

// One intermediate texture to bake before the final channels: the decomposed value (encoded for a 16F linear
// target) rendered into `cacheId`'s target. Emitted bottom-up (nested groups first).
export interface CacheEntry {
  cacheId: string;
  kind: PortKind;
  colorNode: MaterialValue; // the value to render into the cache texture (references upstream caches)
  sizing?: CacheSizing; // render-target size (reference-res floor or absolute tile px); undefined → bake size
}

export interface CompileOptions {
  backend: MaterialBackend;
  // Solo/preview: when set, the surface shows ONLY this node's first output (Blender's "connect to
  // viewer"). The node can be at any nesting depth; its value is captured during compile and routed to
  // baseColor (flat: roughness 1, metallic 0, no normal/height). Ignored if the id isn't found or its
  // first output is a shader closure.
  soloNodeId?: string;
  // Offline decomposition: when provided, each group's outputs are baked to intermediate textures (via this
  // provider) and replaced downstream by a texture sample — so no single channel shader inlines the whole
  // graph (which overflows WebKit's 8192-byte private-var limit / freezes Firefox's sync compiler).
  allocCache?: CacheAlloc;
  // Retention store for build-time uniform arrays (see ConstantArrayAlloc). Provided by the bake service so
  // a constantArray survives across bakes; absent in one-off/live compiles (falls back to a fresh array).
  allocConstantArray?: ConstantArrayAlloc;
  // The authored output resolution (Material Output), used ONLY to derive a tiled noise's repeat factor
  // (repeat = outputResolution / tileSize) so the visible repetition matches between the live preview and the
  // export regardless of the actual bake size. Filled in by compileSockets from readOutputResolution.
  outputResolution?: number;
}

// Mutable holder threaded through the recursive compile so a soloed node at any nesting depth can have its
// first-output value captured. `kind` drives the coercion to colour for the preview bundle.
interface SoloCapture {
  id: string;
  value?: MaterialValue;
  kind?: PortKind;
}

export interface CompiledSockets {
  // The Principled BSDF / Emission bundle feeding Material Output, unpacked by the consumer.
  bundle: MaterialBundle;
  uniforms: Map<string, Record<string, MaterialValue>>;
  // Intermediate group-output textures to bake before the channels, in bottom-up order (empty unless
  // opts.allocCache was provided). The bake service renders each `colorNode` into its `cacheId` target.
  cachePlan: CacheEntry[];
  // Per-node record of how build() consumed each param (live vs constant) — the single source of truth the
  // surface routes edits off. Keyed by node id, then param key.
  paramUsage: ParamUsage;
}

// Reference working resolution for the derivative (normal) path. A cache that COMPUTES a derivative (Normal
// From Height's dFdx/dFdy) or FEEDS one downstream renders at least this big — regardless of a smaller output
// resolution — then downsamples (via mips) to the output. So the normal map is a faithful area-averaged
// miniature at low output res instead of aliasing fine height detail into per-texel speckle. 2048 resolves the
// finest authored grain (noise scale up to 128 → ~16px/period here); the bake service caps it at MAX_CACHE_SIZE.
// Outputs already ≥ this render native (no upscale): the floor only lifts SMALLER outputs to the reference.
const DERIVATIVE_REFERENCE = 2048;

// Does computing the value feeding `startNodeId` involve a derivative node (bakeDerivative, e.g. Normal From
// Height) within THIS subgraph? Walks the upstream edges from the output's source node. Nested groups aren't
// recursed into — a derivative inside one is handled by that group's own cache sizing (compiled first). This
// catches the derivative's OWN containing cache; caches that FEED a derivative across group boundaries are
// found by derivativeTaintedCaches (a whole-document pre-pass).
function dependsOnDerivative(startNodeId: string, doc: MaterialGraphDocument, registry: NodeRegistry): boolean {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = [startNodeId];
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    if (registry.get(node.type).bakeDerivative) return true;
    for (const e of doc.edges) if (e.toNode === id) stack.push(e.fromNode);
  }
  return false;
}

// Whole-document pre-pass: the set of decomposition cache ids (`groupId/portKey`) whose value transitively FEEDS a
// derivative node (bakeDerivative) anywhere downstream — crossing group boundaries. Those caches supply the
// height detail a Normal From Height differentiates, so they must render at the reference resolution too (a
// cache left at the low output res would blur the detail away BEFORE the derivative sees it, and no amount of
// supersampling downstream could recover it). A backward taint from every derivative node, propagating across
// Group Input (out to the parent's feeding source) and Group Output (into the subgraph) boundaries. Node ids
// are unique across the whole document tree, so a single visited-set is safe.
function derivativeTaintedCaches(rootDoc: MaterialGraphDocument, registry: NodeRegistry): Set<string> {
  const tainted = new Set<string>();
  const visitedNodes = new Set<string>();
  const visitedOutputs = new Set<string>(); // cacheIds whose subgraph has been walked (memo)
  const byIdCache = new Map<MaterialGraphDocument, Map<string, GraphNode>>();
  const byIdOf = (doc: MaterialGraphDocument): Map<string, GraphNode> => {
    let m = byIdCache.get(doc);
    if (!m) {
      m = new Map(doc.nodes.map((n) => [n.id, n]));
      byIdCache.set(doc, m);
    }
    return m;
  };
  const giOf = (doc: MaterialGraphDocument): string | undefined =>
    doc.nodes.find((n) => n.type === GROUP_INPUT_TYPE)?.id;

  // Taint the source of one value edge (`fromNode`/`fromOutput`) inside `doc`. `escape(portKey)` handles the
  // case where the source is this doc's Group Input — the value actually comes from the parent group's input.
  const taintSource = (
    doc: MaterialGraphDocument,
    fromNode: string,
    fromOutput: string,
    escape: (portKey: string) => void,
  ): void => {
    if (fromNode === giOf(doc)) {
      escape(fromOutput);
      return;
    }
    const src = byIdOf(doc).get(fromNode);
    if (!src) return;
    if (src.type === GROUP_TYPE && src.subgraph) {
      tainted.add(`${src.id}/${fromOutput}`); // this group output is a cache feeding a derivative
      taintGroupOutput(src, fromOutput, doc, escape);
      return;
    }
    taintNode(doc, fromNode, escape);
  };

  const taintNode = (doc: MaterialGraphDocument, nodeId: string, escape: (portKey: string) => void): void => {
    if (visitedNodes.has(nodeId)) return; // a node lives in one doc, whose escape is fixed → memo is safe
    visitedNodes.add(nodeId);
    for (const e of doc.edges) if (e.toNode === nodeId) taintSource(doc, e.fromNode, e.fromOutput, escape);
  };

  // Continue the backward walk INTO a group from one of its output ports: taint the node feeding that Group
  // Output port; its own Group Input references escape back out to the parent's feeding source.
  const taintGroupOutput = (
    groupNode: GraphNode,
    portKey: string,
    parentDoc: MaterialGraphDocument,
    parentEscape: (portKey: string) => void,
  ): void => {
    const cacheId = `${groupNode.id}/${portKey}`;
    if (visitedOutputs.has(cacheId)) return;
    visitedOutputs.add(cacheId);
    const sub = groupNode.subgraph;
    if (!sub) return;
    const goNode = sub.nodes.find((n) => n.type === GROUP_OUTPUT_TYPE);
    const feed = goNode && sub.edges.find((e) => e.toNode === goNode.id && e.toInput === portKey);
    if (!feed) return;
    const subEscape = (inKey: string): void => {
      for (const pe of parentDoc.edges)
        if (pe.toNode === groupNode.id && pe.toInput === inKey)
          taintSource(parentDoc, pe.fromNode, pe.fromOutput, parentEscape);
    };
    taintSource(sub, feed.fromNode, feed.fromOutput, subEscape);
  };

  // Seed the taint at every derivative node in the document tree, walking each doc with the escape that maps its Group
  // Input back to its parent group's feeding sources.
  const visitDoc = (doc: MaterialGraphDocument, escape: (portKey: string) => void): void => {
    for (const node of doc.nodes) {
      if (registry.get(node.type).bakeDerivative) taintNode(doc, node.id, escape);
      if (node.type === GROUP_TYPE && node.subgraph) {
        const subEscape = (inKey: string): void => {
          for (const pe of doc.edges)
            if (pe.toNode === node.id && pe.toInput === inKey)
              taintSource(doc, pe.fromNode, pe.fromOutput, escape);
        };
        visitDoc(node.subgraph, subEscape);
      }
    }
  };
  visitDoc(rootDoc, () => {});
  return tainted;
}

// Encode a group output for a 16F linear cache target (raw values, no colour transform): floats replicate
// into RGB; vectors/colours are already vec3.
function encodeCache(value: MaterialValue, kind: PortKind): MaterialValue {
  return kind === "float" ? vec3(value) : value;
}
// Sample a cached group output back at the ambient tile uv (valid because the offline bake evaluates every
// node per-texel, so cache[uv] is exactly the group's output at that pixel). (Tiled-noise caches are instead
// sampled uv × repeat in maybeTileNode — the repeating-unit model.)
function decodeCache(tex: THREE.Texture, kind: PortKind): MaterialValue {
  const s = texture(tex, uv());
  return kind === "float" ? s.r : s.xyz;
}

// The graph's authored export resolution: Material Output's `outputResolution` param (px), default 1024. Used
// by the export path (debug/export.ts) as the bake size and by the live surface (textured-surface.ts) as its
// on-screen bake size.
export function readOutputResolution(doc: MaterialGraphDocument): number {
  const out = doc.nodes.find((n) => n.type === MATERIAL_OUTPUT_TYPE);
  const raw = out?.params?.outputResolution;
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1024;
}

// The material family + type-specific settings the graph reconstructs, read from the shader node feeding
// Material Output's `surface` input. Mirrors readOutputResolution: a shallow document read (no compile) so
// both the live path (compileGraph) and the offline surface (textured-surface) derive the type from ONE
// source of truth (the node's params). Falls back to "physical" when the terminal is fed by anything other
// than a shader-material node (legacy principled-bsdf pre-migration, a mix-shader, or nothing) — matching
// the historical hardcoded MeshPhysicalNodeMaterial, so old/uncommon graphs stay backward-compatible.
export function readMaterialSurface(doc: MaterialGraphDocument): {
  type: MaterialType;
  settings: MaterialTypeSettings;
} {
  const out = doc.nodes.find((n) => n.type === MATERIAL_OUTPUT_TYPE);
  const edge = out && doc.edges.find((e) => e.toNode === out.id && e.toInput === "surface");
  const src = edge && doc.nodes.find((n) => n.id === edge.fromNode);
  if (!src || src.type !== SHADER_MATERIAL_TYPE) return { type: "physical", settings: {} };
  const p = src.params;
  const numOr = (v: unknown, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    type: normalizeMaterialType(p.materialType),
    settings: {
      shininess: numOr(p.shininess, 30),
      specular: typeof p.specular === "string" ? p.specular : "#111111",
      gradientSteps: numOr(p.gradientSteps, 3),
      matcap: typeof p.matcap === "string" ? p.matcap : "default",
    },
  };
}

// The FULL resolved scalar config of the surface — every shader-material param with its default applied.
// Where readMaterialSurface returns only the family + non-channel settings (what the node compile needs),
// this returns everything a CLASSIC material needs to be configured by hand (see buildMeshMaterial): the
// scalar fallbacks for channels (used when a channel wasn't baked) plus the physical lobes / phong / toon /
// matcap settings. Defaults mirror the shader-material node's PARAMS. Falls back to a default "physical"
// config when the terminal isn't fed by a shader-material node.
export interface MaterialConfig {
  type: MaterialType;
  baseColor: string;
  metallic: number;
  roughness: number;
  ior: number;
  alpha: number;
  coat: number;
  coatRoughness: number;
  sheen: number;
  sheenRoughness: number;
  transmission: number;
  emission: string;
  emissionStrength: number;
  shininess: number;
  specular: string;
  gradientSteps: number;
  matcap: string;
}

export function readMaterialConfig(doc: MaterialGraphDocument): MaterialConfig {
  const out = doc.nodes.find((n) => n.type === MATERIAL_OUTPUT_TYPE);
  const edge = out && doc.edges.find((e) => e.toNode === out.id && e.toInput === "surface");
  const src = edge && doc.nodes.find((n) => n.id === edge.fromNode);
  const p = (src && src.type === SHADER_MATERIAL_TYPE ? src.params : {}) as Record<string, unknown>;
  const numOr = (v: unknown, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const strOr = (v: unknown, d: string): string => (typeof v === "string" ? v : d);
  return {
    type: normalizeMaterialType(p.materialType),
    baseColor: strOr(p.baseColor, "#cccccc"),
    metallic: numOr(p.metallic, 0),
    roughness: numOr(p.roughness, 0.5),
    ior: numOr(p.ior, 1.5),
    alpha: numOr(p.alpha, 1),
    coat: numOr(p.coat, 0),
    coatRoughness: numOr(p.coatRoughness, 0.03),
    sheen: numOr(p.sheen, 0),
    sheenRoughness: numOr(p.sheenRoughness, 0.3),
    transmission: numOr(p.transmission, 0),
    emission: strOr(p.emission, "#000000"),
    emissionStrength: numOr(p.emissionStrength, 1),
    shininess: numOr(p.shininess, 30),
    specular: strOr(p.specular, "#111111"),
    gradientSteps: numOr(p.gradientSteps, 3),
    matcap: strOr(p.matcap, "default"),
  };
}

// Offline node-level tiling — the REPEATING-UNIT model. If a `bakeTileable` node has `tileSize` set, the node
// builds `period / repeat` periods (via ctx.tileRepeat, so its feature COUNT drops proportionally) into a
// tileSize² buffer, which is then sampled `repeat` times across the texture (uv × repeat). Net effect: the
// texture shows the SAME total feature count = the noise's `scale` (feature size CONSTANT), at the SAME pixel
// density as a full render (CONSTANT crispness — the small buffer holds few periods so it never under-samples),
// and the pattern REPEATS `repeat` times (the only visible change; smaller tileSize → more repetition). The
// compute saving is real: only tileSize² unique noise texels are evaluated. `repeat = outputResolution /
// tileSize`, clamped so each tile keeps ≥ 1 period (see tileRepeatFor). Applies under SOLO too (a deliberate
// change the isolation preview must show). `tileRepeat` here MUST equal what was passed to the node's build.
function tileRepeatFor(node: GraphNode, def: MaterialNodeDef, opts: CompileOptions): number {
  if (opts.backend === "live" || !opts.allocCache || !def.bakeTileable) return 1;
  const raw = node.params.tileSize;
  const tile = typeof raw === "string" && raw !== "off" ? Number(raw) : NaN;
  if (!Number.isFinite(tile) || tile <= 0) return 1;
  const out = opts.outputResolution ?? 1024;
  // repeat = output / tileSize — tileSize is the pixel size of the repeating unit (the noise builds
  // `period / repeat` periods into it, so periods_per_tile × repeat = scale keeps the feature size constant;
  // exact when scale is a multiple of repeat, e.g. scale 128 with repeat 16/8/4). Clamped to `scale` so each
  // tile keeps ≥ 1 period (needed to tile seamlessly); tile ≥ output → repeat 1 (full render, no tiling).
  const scale = Math.max(1, Math.round(Number(node.params.scale) || 1)); // authored feature count (build-time)
  return Math.max(1, Math.min(Math.round(out / tile), scale));
}

// Returns the tiled outputs (a repeat-sampled cache) or undefined when tiling doesn't apply (live backend, no
// cache provider, flag off, tileSize "off", vector/curl output, or no field). `repeat` comes from tileRepeatFor
// (already threaded into the node's build as ctx.tileRepeat).
function maybeTileNode(
  node: GraphNode,
  def: MaterialNodeDef,
  built: Record<string, MaterialValue>,
  opts: CompileOptions,
  cachePlan: CacheEntry[],
  repeat: number,
): Record<string, MaterialValue> | undefined {
  if (opts.backend === "live" || !opts.allocCache || !def.bakeTileable) return undefined;
  if (built.vector !== undefined || built.field === undefined) return undefined; // scalar `field` only (skip curl)
  const raw = node.params.tileSize;
  const tile = typeof raw === "string" && raw !== "off" ? Number(raw) : NaN;
  if (!Number.isFinite(tile) || tile <= 0) return undefined;
  const cacheId = `${node.id}/field`;
  const tex = opts.allocCache(cacheId, "float", { size: tile });
  cachePlan.push({ cacheId, kind: "float", colorNode: encodeCache(built.field, "float"), sizing: { size: tile } });
  // Sample the seamless tile `repeat` times over the texture (RepeatWrapping); 1 = no repeat (full render).
  return { field: texture(tex, uv().mul(float(repeat))).r };
}

// Validate + topo-sort + build every node's TSL outputs, returning the MaterialBundle the shader node
// feeds into Material Output (and per-node uniforms). Shared by compileGraph (live material), the offline
// baker, and the channel baker (PNG export / 2D preview).
// Count every node the compile actually processes: the root document plus, recursively, each group's
// subgraph (compileDocument expands all of them). Used by the bake telemetry's "N nodes" readout.
export function countGraphNodes(doc: MaterialGraphDocument): number {
  let n = 0;
  for (const node of doc.nodes) {
    n += 1;
    if (node.type === GROUP_TYPE && node.subgraph) n += countGraphNodes(node.subgraph);
  }
  return n;
}

export function compileSockets(
  doc: MaterialGraphDocument,
  registry: NodeRegistry,
  optsIn: CompileOptions,
): CompiledSockets {
  // Resolve the authored output resolution once (drives tiled-noise repeat = outputResolution / tileSize, so
  // the repetition is identical in the live preview and the export regardless of the actual bake size).
  const opts: CompileOptions = { ...optsIn, outputResolution: optsIn.outputResolution ?? readOutputResolution(doc) };
  // Domain: 3D world position (live, seamless) or a 2D uv slice (offline bake). Shared by every (sub)document.
  const coord: MaterialValue =
    opts.backend === "live" ? positionWorld : vec3(uv().x, uv().y, float(0));
  const solo: SoloCapture | undefined = opts.soloNodeId ? { id: opts.soloNodeId } : undefined;
  const cachePlan: CacheEntry[] = [];
  // Offline only: which caches feed a derivative (normal) node downstream → render at the reference resolution.
  const derivativeCaches = opts.allocCache ? derivativeTaintedCaches(doc, registry) : new Set<string>();
  const { outputs, uniforms, usage } = compileDocument(
    doc, registry, opts, coord, cachePlan, derivativeCaches, undefined, solo,
  );
  // Solo preview overrides the normal Material Output bundle, but only for a previewable (non-shader) value.
  const bundle =
    solo && solo.value !== undefined && solo.kind && solo.kind !== "shader"
      ? soloBundle(solo.value, solo.kind)
      : resolveBundle(doc, registry, outputs);
  return { bundle, uniforms, cachePlan, paramUsage: usage };
}

// The flat preview bundle for a soloed node: its output as baseColor (floats broadcast to grey), fully
// rough + non-metallic, no normal/height so the raw value reads cleanly on the surface.
function soloBundle(value: MaterialValue, kind: PortKind): MaterialBundle {
  const baseColor = kind === "float" ? vec3(value) : value; // vector/color are already vec3
  return { baseColor, roughness: float(1), metallic: float(0) };
}

interface CompiledDocument {
  outputs: Map<string, Record<string, MaterialValue>>;
  uniforms: Map<string, Record<string, MaterialValue>>;
  usage: ParamUsage;
}

// Compile one document's nodes to per-node TSL outputs (topo order). `seededInputs` is present only for
// a group's subgraph: it supplies the Group Input node's outputs (the external values fed into the
// group). Group nodes recurse via compileGroup.
function compileDocument(
  doc: MaterialGraphDocument,
  registry: NodeRegistry,
  opts: CompileOptions,
  coord: MaterialValue,
  cachePlan: CacheEntry[],
  derivativeCaches: Set<string>,
  seededInputs?: Record<string, MaterialValue | undefined>,
  solo?: SoloCapture,
): CompiledDocument {
  validate(doc, registry, seededInputs !== undefined);
  const order = topoSort(doc);
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const outputsByNode = new Map<string, Record<string, MaterialValue>>();
  const uniformsByNode = new Map<string, Record<string, MaterialValue>>();
  const usageByNode: ParamUsage = new Map();

  for (const id of order) {
    const node = byId.get(id);
    if (!node) continue;
    const ports = nodePorts(node, registry);

    if (node.type === GROUP_INPUT_TYPE) {
      // This node's outputs are the external inputs fed into the subgraph (seeded by the parent group).
      const out: Record<string, MaterialValue> = {};
      for (const p of ports.outputs) out[p.key] = seededInputs?.[p.key];
      outputsByNode.set(id, out);
      continue;
    }
    if (node.type === GROUP_TYPE) {
      const ext = resolveInputs(node, doc, outputsByNode, byId, registry);
      const g = compileGroup(node, registry, opts, coord, cachePlan, derivativeCaches, ext, solo);
      outputsByNode.set(id, g.outputs);
      // Surface the subgraph's uniforms + usage by node id (ids are unique across the doc tree in practice)
      // so a grouped param can be live-tweaked / re-rendered without a recompile, and routed correctly.
      for (const [childId, u] of g.uniforms) uniformsByNode.set(childId, u);
      for (const [childId, u] of g.usage) usageByNode.set(childId, u);
      continue;
    }

    const inputs = resolveInputs(node, doc, outputsByNode, byId, registry);
    const def = registry.get(node.type);
    const uniforms = buildUniforms(def, node);
    uniformsByNode.set(id, uniforms);
    // Offline tiling: the node builds `period / tileRepeat` periods so its feature size survives the ×repeat
    // sampling in maybeTileNode (repeating-unit model). 1 for non-tiled / live.
    const tileRepeat = tileRepeatFor(node, def, opts);
    const ctx = makeBuildCtx(id, node, def, inputs, uniforms, coord, opts, tileRepeat, usageByNode);
    const built = def.build(ctx);
    outputsByNode.set(id, maybeTileNode(node, def, built, opts, cachePlan, tileRepeat) ?? built);
  }

  // Solo capture: if the previewed node lives at this level, grab its first output. First capture wins, so
  // nested levels (compiled via compileGroup) don't clobber an outer match.
  if (solo && solo.value === undefined) {
    const node = byId.get(solo.id);
    const firstOut = node ? nodePorts(node, registry).outputs[0] : undefined;
    if (node && firstOut) {
      solo.value = outputsByNode.get(solo.id)?.[firstOut.key];
      solo.kind = firstOut.kind;
    }
  }

  return { outputs: outputsByNode, uniforms: uniformsByNode, usage: usageByNode };
}

// Build the ctx handed to a node's build(). The param accessors (live/constant/constantArray) each record
// the param's update category into `usageByNode` — the single source of truth the surface routes edits off
// (see memory: node-param-contract). `params`/`uniforms` remain for un-migrated nodes and are removed once
// every node reads through the accessors (the type wall that makes misclassification impossible).
function makeBuildCtx(
  nodeId: string,
  node: GraphNode,
  def: MaterialNodeDef,
  inputs: Record<string, MaterialValue | undefined>,
  uniforms: Record<string, MaterialValue>,
  coord: MaterialValue,
  opts: CompileOptions,
  tileRepeat: number,
  usageByNode: ParamUsage,
): BuildCtx {
  const usage: Record<string, "live" | "constant"> = {};
  usageByNode.set(nodeId, usage);
  const raw = node.params;
  const defaultOf = (key: string): unknown => def.params.find((p) => p.key === key)?.default;
  // No raw `params`/`uniforms` on the returned ctx — the type wall. `uniforms` (the eager map) and `raw` are
  // captured by the closures below so live()/constant() can resolve values, but a node can't reach them.
  return {
    inputs,
    coord,
    backend: opts.backend,
    tileRepeat,
    live(key) {
      // "constant wins": if the node ALSO consumes this param at build time (e.g. wave's scale — an integer
      // period offline plus a live uniform), an edit must rebuild, so never downgrade a recorded constant.
      if (usage[key] !== "constant") usage[key] = "live";
      return uniforms[key];
    },
    constant(key) {
      usage[key] = "constant";
      return raw[key] ?? defaultOf(key);
    },
    constantArray(key, compute, elementType = "float") {
      usage[key] = "constant";
      const data = compute();
      if (opts.allocConstantArray) return opts.allocConstantArray(nodeId, key, data, elementType);
      // Fallback (no retention store — live/one-off compiles): a fresh array node. `.array` holds Vector3
      // objects for vec3, number primitives for float (UniformArrayNode reads either).
      if (elementType === "vec3") {
        const vecs: THREE.Vector3[] = [];
        for (let i = 0; i < data.length; i += 3)
          vecs.push(new THREE.Vector3(data[i], data[i + 1], data[i + 2]));
        return uniformArray(vecs);
      }
      return uniformArray(Array.from(data), "float");
    },
  };
}

// Compile a group node: run its subgraph with the group's external inputs seeded into the Group Input
// node, then read the Group Output node's inputs back as the group's outputs. Recursion handles nesting.
function compileGroup(
  groupNode: GraphNode,
  registry: NodeRegistry,
  opts: CompileOptions,
  coord: MaterialValue,
  cachePlan: CacheEntry[],
  derivativeCaches: Set<string>,
  externalInputs: Record<string, MaterialValue | undefined>,
  solo?: SoloCapture,
): {
  outputs: Record<string, MaterialValue>;
  uniforms: Map<string, Record<string, MaterialValue>>;
  usage: ParamUsage;
} {
  const sub = groupNode.subgraph;
  if (!sub) return { outputs: {}, uniforms: new Map(), usage: new Map() };
  // Keep the subgraph's per-node uniforms + usage (recursively, incl. deeper groups) so the parent can
  // surface them — without this the editor's live-tweak / offline re-render fast paths never see params
  // inside a group. Nested groups compiled in here append their cache entries first (bottom-up cachePlan).
  const { outputs, uniforms, usage } = compileDocument(
    sub, registry, opts, coord, cachePlan, derivativeCaches, externalInputs, solo,
  );
  const goNode = sub.nodes.find((n) => n.type === GROUP_OUTPUT_TYPE);
  const result: Record<string, MaterialValue> = {};
  if (!goNode) return { outputs: result, uniforms, usage };
  const subById = new Map(sub.nodes.map((n) => [n.id, n]));
  for (const p of nodePorts(goNode, registry).inputs) {
    const edge = sub.edges.find((e) => e.toNode === goNode.id && e.toInput === p.key);
    const value = edge ? resolveEdgeValue(edge, p.kind, outputs, subById, registry) : undefined;
    // Decompose (offline): bake this output into its own texture and hand downstream a sample of it, so the
    // group's computation lives in ONE small shader (the cache) instead of being inlined into every channel.
    // Only cacheable kinds (float/vector/colour); a soloed subtree must stay inlined so the preview is exact.
    if (opts.allocCache && value !== undefined && p.kind !== "shader" && !solo) {
      const cacheId = `${groupNode.id}/${p.key}`;
      // Render this cache at the reference resolution (a `minSize` floor + mips) when it either COMPUTES a
      // derivative (nfh on its upstream path — its dFdx needs a fine, fixed grid) or FEEDS one downstream
      // (a whole-document taint — the height detail nfh differentiates must survive at low output res). Either
      // way the cache renders at ≥ DERIVATIVE_REFERENCE and downsamples faithfully via mips (see cacheSizeFor).
      // Auto: no per-node config, keyed off the node def's bakeDerivative flag.
      const onDerivativePath =
        (edge && dependsOnDerivative(edge.fromNode, sub, registry)) || derivativeCaches.has(cacheId);
      const sizing: CacheSizing | undefined = onDerivativePath ? { minSize: DERIVATIVE_REFERENCE } : undefined;
      const tex = opts.allocCache(cacheId, p.kind, sizing);
      cachePlan.push({ cacheId, kind: p.kind, colorNode: encodeCache(value, p.kind), sizing });
      result[p.key] = decodeCache(tex, p.kind);
    } else {
      result[p.key] = value;
    }
  }
  return { outputs: result, uniforms, usage };
}

// Surface-contract defaults shared by every material family (DoubleSide + polygon offset so the plane and
// sphere z-fight cleanly with the shadow catcher).
const SURFACE_DEFAULTS = {
  side: THREE.DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1,
} as const;

// Construct the stock node material for `type` with the surface-contract defaults + any type-specific
// settings (phong shininess/specular, toon gradient map, matcap). Shared by the live compile here and the
// offline surface material. Default "physical" keeps every legacy caller working unchanged.
export function newSurfaceMaterial(
  type: MaterialType = "physical",
  settings: MaterialTypeSettings = {},
): NodeMaterial {
  switch (type) {
    case "standard":
      return new MeshStandardNodeMaterial({ metalness: 0, roughness: 0.9, ...SURFACE_DEFAULTS });
    case "lambert":
      return new MeshLambertNodeMaterial({ ...SURFACE_DEFAULTS });
    case "phong":
      return new MeshPhongNodeMaterial({
        shininess: settings.shininess ?? 30,
        specular: new THREE.Color(settings.specular ?? "#111111"),
        ...SURFACE_DEFAULTS,
      });
    case "toon":
      return new MeshToonNodeMaterial({ gradientMap: gradientMapFor(settings.gradientSteps), ...SURFACE_DEFAULTS });
    case "matcap":
      return new MeshMatcapNodeMaterial({ matcap: matcapFor(settings.matcap), ...SURFACE_DEFAULTS });
    case "physical":
    default:
      return new MeshPhysicalNodeMaterial({ metalness: 0, roughness: 0.9, ...SURFACE_DEFAULTS });
  }
}

// Unpack a resolved bundle onto the material's channels, gated by the family's capabilities
// (MATERIAL_TYPE_CAPS): common channels (colour/normal/opacity) apply to every family; roughness/metalness
// only to Standard-derived; the physical lobes (ior/clearcoat/sheen/transmission) only to Physical; ao and
// emissive per their flags (Matcap is unlit → neither). The material argument is typed loosely because the
// physical-only node setters don't exist on the narrower classes; the CAPS gate guarantees we only touch a
// setter the concrete instance actually has. Used by the live compile; the offline surface builder mirrors
// this gating against baked textures in textured-surface.wire.
export function applyBundle(material: NodeMaterial, bundle: MaterialBundle, type: MaterialType): void {
  const caps = MATERIAL_TYPE_CAPS[type];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- per-family channel setters (see above)
  const m = material as any;
  // Common channels — every family lights these.
  if (bundle.baseColor) m.colorNode = bundle.baseColor;
  if (bundle.normal) m.normalNode = bundle.normal;
  if (bundle.alpha) {
    m.opacityNode = bundle.alpha;
    m.transparent = true;
  }
  // AO modulates only the indirect/IBL term. Compose the mesh's per-vertex FORM AO (to-buffer-geometry's
  // `vertexAo`, geometry-driven) with the graph's texture-scale DETAIL AO when connected — same as the
  // offline backend's bakedAO × vertexAo. Skipped entirely for unlit Matcap (no aoNode).
  if (caps.ao) {
    const vertexAo = attribute("vertexAo", "float");
    m.aoNode = bundle.ambientOcclusion ? bundle.ambientOcclusion.mul(vertexAo) : vertexAo;
  }
  if (caps.emissive && bundle.emission) m.emissiveNode = bundle.emission;
  if (caps.roughMetal) {
    if (bundle.roughness) m.roughnessNode = bundle.roughness;
    if (bundle.metallic) m.metalnessNode = bundle.metallic;
  }
  // Physical channels — only present when the lobe is active, so unused lobes stay disabled.
  if (caps.physicalLobes) {
    if (bundle.ior) m.iorNode = bundle.ior;
    if (bundle.coat) m.clearcoatNode = bundle.coat;
    if (bundle.coatRoughness) m.clearcoatRoughnessNode = bundle.coatRoughness;
    if (bundle.sheen) m.sheenNode = bundle.sheen; // float weight; three wraps as vec3 (grey sheen)
    if (bundle.sheenRoughness) m.sheenRoughnessNode = bundle.sheenRoughness;
    if (bundle.transmission) m.transmissionNode = bundle.transmission;
  }
}

// Compile a document into the LIVE surface material: a procedural node material (the family chosen by the
// graph's materialType, default Physical) whose channels are evaluated per fragment over positionWorld
// (seamless 3D). The offline backend bakes channels to textures instead (see textured-surface).
export function compileGraph(
  doc: MaterialGraphDocument,
  registry: NodeRegistry,
  opts: CompileOptions,
): CompiledMaterial {
  const { bundle, uniforms: uniformsByNode } = compileSockets(doc, registry, opts);
  const { type, settings } = readMaterialSurface(doc);
  const material = newSurfaceMaterial(type, settings);
  applyBundle(material, bundle, type);
  return { material, uniforms: uniformsByNode };
}

function resolveInputs(
  node: GraphNode,
  doc: MaterialGraphDocument,
  outputs: Map<string, Record<string, MaterialValue>>,
  byId: Map<string, GraphNode>,
  registry: NodeRegistry,
): Record<string, MaterialValue | undefined> {
  const ins: Record<string, MaterialValue | undefined> = {};
  for (const port of nodePorts(node, registry).inputs) {
    const edge = doc.edges.find((e) => e.toNode === node.id && e.toInput === port.key);
    ins[port.key] = edge ? resolveEdgeValue(edge, port.kind, outputs, byId, registry) : undefined;
  }
  return ins;
}

// Fetch an edge's upstream TSL value, coerced to the target input kind. Permissive linking: when the
// upstream output kind differs, inject the matching coercion (validate() guarantees one exists). Shared
// by every typed input — intermediate nodes AND the terminal pbr-output channels. See plan L6.
function resolveEdgeValue(
  edge: { fromNode: string; fromOutput: string },
  targetKind: PortKind,
  outputs: Map<string, Record<string, MaterialValue>>,
  byId: Map<string, GraphNode>,
  registry: NodeRegistry,
): MaterialValue | undefined {
  let value = outputs.get(edge.fromNode)?.[edge.fromOutput];
  if (value === undefined) return undefined;
  const fromNode = byId.get(edge.fromNode);
  const outKind = fromNode
    ? nodePorts(fromNode, registry).outputs.find((p) => p.key === edge.fromOutput)?.kind
    : undefined;
  if (outKind && outKind !== targetKind) {
    const conv = coercionFor(outKind, targetKind);
    if (conv) value = coerce(value, conv);
  }
  return value;
}

// Apply a port-kind coercion to a TSL value. Mirrors Blender's implicit socket conversions (L6).
function coerce(value: MaterialValue, conversion: Coercion): MaterialValue {
  switch (conversion) {
    case "float-to-vector":
    case "float-to-color":
      return vec3(value); // broadcast x -> (x, x, x)
    case "vector-to-float":
      return value.x.add(value.y).add(value.z).div(3); // average of components
    case "color-to-float":
      return luminance(value); // rgb -> bw
    case "identity":
    case "vector-to-color": // both are vec3 — reinterpret channels
    case "color-to-vector":
      return value;
  }
}

function buildUniforms(def: MaterialNodeDef, node: GraphNode): Record<string, MaterialValue> {
  const out: Record<string, MaterialValue> = {};
  for (const p of def.params) {
    const raw = node.params[p.key] ?? p.default;
    if (p.type === "color") {
      out[p.key] = uniform(new THREE.Color(raw as THREE.ColorRepresentation));
    } else if (p.type === "vec3") {
      const v = (raw ?? { x: 0, y: 0, z: 0 }) as { x: number; y: number; z: number };
      out[p.key] = uniform(new THREE.Vector3(v.x, v.y, v.z));
    } else if (p.type === "float" || p.type === "int") {
      // Coerce non-finite values (e.g. a cleared numeric field → NaN) to the param default, then 0 — a NaN
      // uniform serialises to invalid WGSL (`NaN.0`) and invalidates the whole shader.
      const n = Number(raw);
      out[p.key] = uniform(Number.isFinite(n) ? n : Number(p.default) || 0);
    } else if (p.type === "curve") {
      // 20 floats ([C,R,G,B] × 5 points); build() indexes via .element(). uniformArray.update() copies
      // its `.array` to the GPU each frame, so the controller can mutate it live (no recompile).
      out[p.key] = uniformArray(curveToArray(raw as CurveValue | undefined), "float");
    }
    // bool / select: build() reads the raw value via ctx.params.
  }
  return out;
}

// The bundle feeding Material Output's Surface input. The shader node (Principled/Emission) emitted a
// MaterialBundle as its `shader`-kind output; resolveEdgeValue passes it through (shader→shader is
// identity, never coerced). Returns {} when nothing is wired to Surface.
function resolveBundle(
  doc: MaterialGraphDocument,
  registry: NodeRegistry,
  outputs: Map<string, Record<string, MaterialValue>>,
): MaterialBundle {
  const outNode = doc.nodes.find((n) => n.type === MATERIAL_OUTPUT_TYPE);
  if (!outNode) return {};
  const edge = doc.edges.find((e) => e.toNode === outNode.id && e.toInput === "surface");
  if (!edge) return {};
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const value = resolveEdgeValue(edge, "shader", outputs, byId, registry);
  return (value as MaterialBundle | undefined) ?? {};
}

function topoSort(doc: MaterialGraphDocument): string[] {
  const indeg = new Map<string, number>();
  for (const n of doc.nodes) indeg.set(n.id, 0);
  const adj = new Map<string, string[]>();
  for (const e of doc.edges) {
    if (!indeg.has(e.fromNode) || !indeg.has(e.toNode)) continue;
    adj.set(e.fromNode, [...(adj.get(e.fromNode) ?? []), e.toNode]);
    indeg.set(e.toNode, (indeg.get(e.toNode) ?? 0) + 1);
  }
  const queue = doc.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (order.length !== doc.nodes.length) throw new Error("Material graph has a cycle");
  return order;
}

function validate(doc: MaterialGraphDocument, registry: NodeRegistry, isSubgraph = false): void {
  // The top-level document ends in Material Output; a group's subgraph ends in Group Output.
  const terminalType = isSubgraph ? GROUP_OUTPUT_TYPE : MATERIAL_OUTPUT_TYPE;
  const terms = doc.nodes.filter((n) => n.type === terminalType);
  if (terms.length !== 1) {
    throw new Error(`Expected exactly one ${terminalType} node, found ${terms.length}`);
  }
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const seenInput = new Set<string>();
  for (const e of doc.edges) {
    const from = byId.get(e.fromNode);
    const to = byId.get(e.toNode);
    if (!from) throw new Error(`Edge from unknown node '${e.fromNode}'`);
    if (!to) throw new Error(`Edge to unknown node '${e.toNode}'`);
    const outPort = nodePorts(from, registry).outputs.find((p) => p.key === e.fromOutput);
    const inPort = nodePorts(to, registry).inputs.find((p) => p.key === e.toInput);
    if (!outPort) throw new Error(`Node '${from.type}' has no output '${e.fromOutput}'`);
    if (!inPort) throw new Error(`Node '${to.type}' has no input '${e.toInput}'`);
    if (outPort.kind !== inPort.kind && !coercionFor(outPort.kind, inPort.kind)) {
      throw new Error(
        `Type mismatch (no coercion): ${from.type}.${e.fromOutput} (${outPort.kind}) -> ${to.type}.${e.toInput} (${inPort.kind})`,
      );
    }
    const inputKey = `${e.toNode}/${e.toInput}`;
    if (seenInput.has(inputKey)) throw new Error(`Multiple connections into ${to.type}.${e.toInput}`);
    seenInput.add(inputKey);
  }
}
