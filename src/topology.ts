import { nodePorts, type NodeRegistry } from "./graph/registry";
import type { CurveValue, GraphNode, MaterialGraphDocument, ParamDef, Vec3Value } from "./graph/types";
import { curveToArray } from "./graph/types";

// Order-independent stringify: object keys are sorted, so two structurally equal values always produce the
// same text. Exported because the bake cache key is built from the same convention (see createMaterialParamKey).
export function canonicalStringify(value: unknown): string {
  return stable(value);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${key}:${stable(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function structuralParams(node: GraphNode, registry: NodeRegistry): Record<string, unknown> {
  const def = registry.get(node.type);
  const params = def.paramsFor ? def.paramsFor(node.params) : def.params;
  const out: Record<string, unknown> = {};
  for (const param of params) {
    if (
      param.type === "int" ||
      param.type === "bool" ||
      param.type === "select" ||
      param.bakeStructural
    ) {
      out[param.key] = node.params[param.key];
    }
  }
  return out;
}

function nodeTopology(node: GraphNode, registry: NodeRegistry): unknown {
  return {
    id: node.id,
    type: node.type,
    enabled: node.enabled,
    ports: nodePorts(node, registry),
    params: structuralParams(node, registry),
    subgraph: node.subgraph ? documentTopology(node.subgraph, registry) : null,
  };
}

function documentTopology(doc: MaterialGraphDocument, registry: NodeRegistry): unknown {
  return {
    version: doc.version,
    nodes: doc.nodes
      .map((node) => nodeTopology(node, registry))
      .sort((a, b) => String((a as { id: string }).id).localeCompare(String((b as { id: string }).id))),
    edges: [...doc.edges].sort((a, b) => stable(a).localeCompare(stable(b))),
  };
}

export function createMaterialTopologyKey(doc: MaterialGraphDocument, registry: NodeRegistry): string {
  return stable(documentTopology(doc, registry));
}

// --- effective param key (the other half of a bake identity) ----------------------------------------
//
// createMaterialTopologyKey deliberately OMITS float/color/vec3/curve params: they are live uniforms, so a
// change re-renders without recompiling and the topology (what must be recompiled) is unchanged. That makes
// it wrong on its own as a cache key — `scale: 5 → 18` changes every texel but not the topology.
//
// This is the complement: EVERY param of EVERY node, canonicalized. Together the two keys identify a bake.
//
// Three properties make it usable as a cache key, all of them load-bearing:
//   1. Registry defaults are merged in. `node.params` is SPARSE (ctx.constant falls back to the ParamDef
//      default), so an unset param and an explicitly-default one MUST key identically or the cache misses
//      on documents that bake identically.
//   2. Values are canonicalized per type, so `"5"` (MCP sends strings), `5`, and `5.000000001` agree, and
//      `-0` never differs from `0`. Slider noise must not invalidate a cache entry.
//   3. It reads the STATIC `def.params`, not nodeParamDefs/paramsFor. paramsFor is a UI-visibility filter
//      (see MaterialNodeDef.paramsFor) and the compiler still builds from the full list, so a
//      context-hidden param can still reach build() and affect texels. Missing one would restore WRONG
//      textures — the one failure mode this key exists to prevent.
//
// Cosmetics (label, position, metadata, ui) are never read, so renames and pan/zoom don't invalidate.
function canonicalNumber(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return typeof value === "number" ? "nan" : `raw:${String(value)}`;
  // Round to 9 significant digits: kills the float noise a slider drag leaves behind, and makes the string
  // form MCP sends agree with the number the editor writes. Normalize -0, which stringifies differently.
  const rounded = Number(n.toPrecision(9));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function canonicalColor(value: unknown): string {
  // Colours reach us as a THREE.ColorRepresentation: 0xrrggbb, "#rrggbb"/"#rgb", a CSS name, or {r,g,b}.
  // 0xffffff and "#ffffff" are the SAME colour and so must produce the same key.
  if (typeof value === "number") return `#${(value >>> 0 & 0xffffff).toString(16).padStart(6, "0")}`;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
    return s;
  }
  if (value && typeof value === "object") {
    const c = value as Partial<{ r: number; g: number; b: number }>;
    if (typeof c.r === "number") {
      return `rgb(${canonicalNumber(c.r)},${canonicalNumber(c.g)},${canonicalNumber(c.b)})`;
    }
  }
  return stable(value);
}

function canonicalParamValue(value: unknown, param: ParamDef): string {
  switch (param.type) {
    case "float":
    case "int":
      return canonicalNumber(value);
    case "bool":
      return (typeof value === "string" ? value.trim().toLowerCase() === "true" : Boolean(value))
        ? "true"
        : "false";
    case "color":
      return canonicalColor(value);
    case "select":
      return String(value);
    case "vec3": {
      const v = (value ?? {}) as Partial<Vec3Value>;
      return `(${canonicalNumber(v.x)},${canonicalNumber(v.y)},${canonicalNumber(v.z)})`;
    }
    case "curve":
      // curveToArray fills the identity ramp for any missing/short channel, so a sparse curve keys the same
      // as the explicit one it compiles to — the same normalization the uniform upload does.
      return `[${curveToArray(value as CurveValue | undefined).map(canonicalNumber).join(",")}]`;
    default:
      return stable(value);
  }
}

function nodeParamKey(node: GraphNode, registry: NodeRegistry): string {
  // An unrecognised type (a consumer's custom node) can't be default-merged, so fall back to keying every
  // raw param present. Over-keying costs a cache miss; under-keying would serve the wrong textures.
  if (!registry.has(node.type)) {
    return `${node.id}!${stable(node.params)}`;
  }
  const defs = registry.get(node.type).params;
  const parts: string[] = [];
  for (const param of defs) {
    const raw = node.params[param.key] === undefined ? param.default : node.params[param.key];
    parts.push(`${param.key}=${canonicalParamValue(raw, param)}`);
  }
  // Params with no ParamDef (a stale document key, or one written by a newer build) still affect nothing we
  // can reason about — key them raw so they can never be silently dropped.
  const known = new Set(defs.map((p) => p.key));
  const extra = Object.keys(node.params)
    .filter((k) => !known.has(k))
    .sort();
  for (const key of extra) parts.push(`${key}~${stable(node.params[key])}`);
  return `${node.id}{${parts.join(",")}}`;
}

export function createMaterialParamKey(doc: MaterialGraphDocument, registry: NodeRegistry): string {
  const nodes = [...doc.nodes].sort((a, b) => a.id.localeCompare(b.id));
  return nodes
    .map((node) => {
      const own = nodeParamKey(node, registry);
      return node.subgraph ? `${own}/[${createMaterialParamKey(node.subgraph, registry)}]` : own;
    })
    .join(";");
}
