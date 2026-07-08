import defaultDocument from "./default-document.json";
import { compileSockets } from "./graph/compiler";
import { defaultRegistry, nodeParamDefs, type NodeRegistry } from "./graph/registry";
import {
  MATERIAL_OUTPUT_TYPE,
  SHADER_MATERIAL_TYPE,
  type GraphChange,
  type MaterialGraphDocument,
  type MaterialGraphSource,
  type ParamDef,
} from "./graph/types";

export const MATERIAL_DOCUMENT_VERSION = 4;

export function cloneMaterialDocument(doc: MaterialGraphDocument): MaterialGraphDocument {
  return structuredClone(doc);
}

export function createDefaultMaterialDocument(): MaterialGraphDocument {
  return cloneMaterialDocument(defaultDocument as MaterialGraphDocument);
}

// v2 → v3: the legacy Principled BSDF node is replaced by the polymorphic shader-material node. Rewrite each
// `principled-bsdf` node in place to `shader-material` with materialType="physical" (its params are a subset
// of the new node's superset, so they copy verbatim), recursing into group subgraphs. Idempotent — a v3 doc
// has no principled-bsdf nodes, so re-running is a no-op.
function migrateNodesToV3(doc: MaterialGraphDocument): void {
  for (const node of doc.nodes) {
    if (node.type === "principled-bsdf") {
      node.type = SHADER_MATERIAL_TYPE;
      node.params = { ...node.params, materialType: "physical" };
    }
    if (node.subgraph) migrateNodesToV3(node.subgraph);
  }
}

// v3 → v4: the tileable-noise "noiseType" selector used to conflate genuine algorithms with Perlin
// compositions (curl/paper/wool/stone/erosion — all derived from the curl of Perlin). Those five move out of
// the algorithm list into a Perlin-scoped `preset` param. Rewrite each legacy node to perlin-fbm + the
// matching preset, recursing into group subgraphs. Idempotent — a v4 doc has no matching noiseType values.
const TILEABLE_NOISE_PRESETS = new Set(["curl", "paper", "wool", "stone", "erosion"]);
function migrateNodesToV4(doc: MaterialGraphDocument): void {
  for (const node of doc.nodes) {
    if (node.type === "tileable-noise" && TILEABLE_NOISE_PRESETS.has(node.params.noiseType as string)) {
      node.params = { ...node.params, preset: node.params.noiseType, noiseType: "perlin-fbm" };
    }
    if (node.subgraph) migrateNodesToV4(node.subgraph);
  }
}

export function migrateMaterialDocument(doc: MaterialGraphDocument): MaterialGraphDocument {
  const next = cloneMaterialDocument(doc);
  // A missing version is treated as pre-v3 (legacy); every step is idempotent so this is always safe.
  if ((doc.version ?? 0) < 3) migrateNodesToV3(next);
  if ((doc.version ?? 0) < 4) migrateNodesToV4(next);
  next.version = MATERIAL_DOCUMENT_VERSION;
  return next;
}

function findNode(doc: MaterialGraphDocument, nodeId: string) {
  return doc.nodes.find((node) => node.id === nodeId);
}

function findParam(defs: ParamDef[], key: string): ParamDef | undefined {
  return defs.find((def) => def.key === key);
}

function paramChangeKind(param: ParamDef): GraphChange["kind"] {
  if (param.structural) return "structural"; // construction-time settings (e.g. phong shininess/specular)
  return param.type === "float" || param.type === "color" || param.type === "vec3" || param.type === "curve"
    ? "param"
    : "structural";
}

export class MaterialGraphSession implements MaterialGraphSource {
  private doc: MaterialGraphDocument;
  private readonly listeners = new Set<(change: GraphChange) => void>();
  private lastError_: string | null = null;
  private soloNode_: string | null = null;

  constructor(
    doc: MaterialGraphDocument = createDefaultMaterialDocument(),
    private readonly registry: NodeRegistry = defaultRegistry,
  ) {
    this.doc = migrateMaterialDocument(doc);
    this.validate(this.doc);
  }

  get document(): MaterialGraphDocument {
    return this.doc;
  }

  get lastError(): string | null {
    return this.lastError_;
  }

  get soloNode(): string | null {
    return this.soloNode_;
  }

  getRegistry(): NodeRegistry {
    return this.registry;
  }

  compileBundle(opts: import("./graph/compiler").CompileOptions): import("./graph/compiler").CompiledSockets {
    try {
      const result = compileSockets(this.doc, this.registry, opts);
      this.lastError_ = null;
      return result;
    } catch (err) {
      this.lastError_ = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  onChange(fn: (change: GraphChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setDocument(doc: MaterialGraphDocument): void {
    const next = migrateMaterialDocument(doc);
    this.validate(next);
    this.doc = next;
    this.emit({ kind: "structural" });
  }

  getDocument(): MaterialGraphDocument {
    return cloneMaterialDocument(this.doc);
  }

  setSoloNode(nodeId: string | null): void {
    if (nodeId === this.soloNode_) return;
    this.soloNode_ = nodeId;
    this.emit({ kind: "structural" });
  }

  setOutputResolution(size: number): void {
    const out = this.doc.nodes.find((node) => node.type === MATERIAL_OUTPUT_TYPE);
    if (!out) return;
    const value = String(size);
    if (out.params.outputResolution === value) return;
    out.params.outputResolution = value;
    this.emit({ kind: "structural" });
  }

  setOutputTargets(targets: { resolution?: number; size?: number }): void {
    this.setOutputResolution(targets.resolution ?? targets.size ?? 1024);
  }

  setNodeParam(nodeId: string, key: string, value: unknown): boolean {
    const node = findNode(this.doc, nodeId);
    if (!node) return false;
    const def = this.registry.get(node.type);
    const param = findParam(nodeParamDefs(node, this.registry), key) ?? findParam(def.params, key);
    if (!param) return false;
    if (Object.is(node.params[key], value)) return true;
    node.params[key] = value;
    if (paramChangeKind(param) === "param") {
      this.emit({
        kind: "param",
        nodeId,
        key,
        paramType: param.type,
        value,
        bakeStructural: param.bakeStructural,
      });
    } else {
      this.emit({ kind: "structural" });
    }
    return true;
  }

  updateNodeParams(nodeId: string, patch: Record<string, unknown>): boolean {
    let changed = false;
    for (const [key, value] of Object.entries(patch)) changed = this.setNodeParam(nodeId, key, value) || changed;
    return changed;
  }

  private validate(doc: MaterialGraphDocument): void {
    compileSockets(doc, this.registry, { backend: "live" });
    this.lastError_ = null;
  }

  private emit(change: GraphChange): void {
    for (const fn of this.listeners) fn(change);
  }
}
