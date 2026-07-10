import type { MaterialGraphDocument, GraphNode } from "./types";
import type { NodeRegistry } from "./registry";

// Per-node cost profiling — the pure (GPU-free) half. The measuring loop lives on MaterialBakeService
// (`profileNodes`) because it needs the private serial queue, renderer, and GPU back-pressure.
//
// WHAT "per node" honestly means here: the compiler fuses every node into one WGSL program per channel,
// so a node can never be timed inside a shader. The reliable measurable unit is a node's SUBTREE rendered
// in isolation (the compiler's solo mechanism). Subtree totals are ground truth; `marginalMs` (subtree −
// costliest direct input's subtree) is an attribution HINT — a node whose inputs are shared by several
// consumers pays its upstream once per subtree here but once per SHADER in a real bake.

export interface NodeProfileOptions {
  nodeIds?: string[]; // restrict to these ids (default: every profilable node)
  size?: number; // render-target size, default 512
  runs?: number; // warm renders per node (median taken), default 6
}

export interface NodeProfileRow {
  nodeId: string;
  type: string;
  label?: string;
  pipelineMs: number; // cold render: TSL build + WGSL/pipeline compile + first draw
  renderMs: number; // median of warm re-renders (pure GPU cost of the subtree at `size`²)
  marginalMs: number; // renderMs − max(direct inputs' renderMs) — approximate, see header
  error?: string; // compile failure for this subtree (row kept so the table stays complete)
}

export interface NodeProfileReport {
  size: number;
  runs: number;
  overheadMs: number; // median cost of rendering a constant — the floor every renderMs includes
  nodes: NodeProfileRow[]; // sorted by renderMs desc
}

// Nodes whose subtree can be soloed to a color: everything except the terminal output and shader-closure
// emitters (their first output is a `shader` marker the solo path ignores). Disabled nodes are skipped.
export function profilableNodes(
  doc: MaterialGraphDocument,
  registry: NodeRegistry,
  only?: string[],
): GraphNode[] {
  const filter = only && only.length ? new Set(only) : null;
  return doc.nodes.filter((n) => {
    if (n.enabled === false) return false;
    if (filter && !filter.has(n.id)) return false;
    const def = registry.has(n.type) ? registry.get(n.type) : null;
    if (!def) return false;
    return def.nodeClass !== "shader" && def.nodeClass !== "output";
  });
}

export function median(samples: number[]): number {
  if (!samples.length) return 0;
  const s = [...samples].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// marginalMs = renderMs − max(direct inputs' renderMs); source nodes subtract the constant-render floor
// instead. Clamped at 0 — timing noise can make a subtree measure faster than its input.
export function deriveMarginals(rows: NodeProfileRow[], doc: MaterialGraphDocument, overheadMs: number): void {
  const byId = new Map(rows.map((r) => [r.nodeId, r]));
  for (const row of rows) {
    const inputs = doc.edges
      .filter((e) => e.toNode === row.nodeId)
      .map((e) => byId.get(e.fromNode)?.renderMs)
      .filter((v): v is number => v !== undefined);
    const base = inputs.length ? Math.max(...inputs) : overheadMs;
    row.marginalMs = Math.max(0, row.renderMs - base);
  }
}
