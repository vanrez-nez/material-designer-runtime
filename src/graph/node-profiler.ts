import {
  GROUP_INPUT_TYPE,
  GROUP_OUTPUT_TYPE,
  GROUP_TYPE,
  type MaterialGraphDocument,
  type GraphNode,
  type NodeProfileWorkload,
  type PortDef,
} from "./types";
import { nodePorts, type NodeRegistry } from "./registry";

// Per-node cost profiling — the pure (GPU-free) half. The measuring loop lives on MaterialBakeService
// (`profileNodes`) because it needs the private serial queue, renderer, and GPU back-pressure.
//
// Each output gets two controlled node-only pipelines: the real node with cheap varying stand-ins for every
// connected input, and a minimal dependency baseline over those same stand-ins. Their measured difference is
// the node-local cost. A separate real-subtree pipeline remains in the report as context, never attribution.

export interface NodeProfileOptions {
  nodeIds?: string[]; // restrict to these ids (default: every profilable node)
  size?: number; // render-target size, default 512
  runs?: number; // warm GPU renders per node (median taken), default 6
  compileRuns?: number; // independently cache-busted pipeline compiles per node (median taken), default 3
}

export interface NodeProfileShaderMetrics {
  isolatedFragmentBytes: number;
  baselineFragmentBytes: number;
  fragmentByteDelta: number;
  isolatedFragmentLines: number;
  baselineFragmentLines: number;
  isolatedFunctionCount: number;
  baselineFunctionCount: number;
  functionCountDelta: number;
  isolatedLoopCount: number;
  baselineLoopCount: number;
  loopCountDelta: number;
}

function shaderSourceStats(source: string): {
  bytes: number;
  lines: number;
  functions: number;
  loops: number;
} {
  return {
    bytes: new TextEncoder().encode(source).byteLength,
    lines: source.length === 0 ? 0 : source.split("\n").length,
    functions: (source.match(/\bfn\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/g) ?? []).length,
    loops: (source.match(/\b(?:for|while|loop)\s*(?:\(|\{)/g) ?? []).length,
  };
}

export function measureNodeShaderMetrics(
  isolatedSource: string,
  baselineSource: string,
): NodeProfileShaderMetrics {
  const isolated = shaderSourceStats(isolatedSource);
  const baseline = shaderSourceStats(baselineSource);
  return {
    isolatedFragmentBytes: isolated.bytes,
    baselineFragmentBytes: baseline.bytes,
    fragmentByteDelta: Math.max(0, isolated.bytes - baseline.bytes),
    isolatedFragmentLines: isolated.lines,
    baselineFragmentLines: baseline.lines,
    isolatedFunctionCount: isolated.functions,
    baselineFunctionCount: baseline.functions,
    functionCountDelta: Math.max(0, isolated.functions - baseline.functions),
    isolatedLoopCount: isolated.loops,
    baselineLoopCount: baseline.loops,
    loopCountDelta: Math.max(0, isolated.loops - baseline.loops),
  };
}

export interface NodeProfileRow {
  nodeId: string;
  type: string;
  label?: string;
  outputKey: string;
  outputLabel?: string;
  outputKind: PortDef["kind"];
  graphCompileMs: number; // CPU time to build/capture the real subtree (context only)
  isolatedGraphCompileMs: number; // CPU time to build/capture the isolated node
  subtreeCompileMs: number; // full real ancestor subtree pipeline compile median
  subtreeGpuMs: number; // full real ancestor subtree GPU pass median
  isolatedCompileMs: number; // real node-only pipeline total, before its matched baseline is removed
  isolatedGpuMs: number; // real node-only GPU pass total, before its matched baseline is removed
  baselineCompileMs: number; // minimal matched input/output plumbing pipeline compile median
  baselineGpuMs: number; // minimal matched input/output plumbing GPU pass median
  compileMs: number; // measured node-local compile delta: isolatedCompileMs − baselineCompileMs
  gpuPairedDeltaMs?: number; // signed median of interleaved (isolated − baseline) timestamp pairs
  gpuMs: number; // actionable node-local GPU delta (paired delta, clamped at zero)
  workload?: NodeProfileWorkload; // calculated selected-kernel work; not a timing attribution
  shaderMetrics?: NodeProfileShaderMetrics; // generated fragment WGSL, isolated vs matched baseline
  error?: string; // compile failure for this output (row kept so the table stays inspectable)
}

export interface NodeProfileReport {
  size: number;
  runs: number;
  compileRuns: number;
  profileRunId: string;
  measurementMode: "isolated-node-minus-matched-baseline";
  timingMode: "timestamp-query" | "wall-clock-fallback";
  timestampScope: "render-context" | "aggregate-frame" | "unavailable";
  timestampQuerySupported: boolean;
  timestampTrackingEnabled: boolean;
  overheadMs: number; // median constant-pass GPU/wall floor every gpuMs includes
  compileOverheadMs: number; // constant shader pipeline compile floor
  nodes: NodeProfileRow[]; // one row per non-shader output, sorted by measured node-local cost
}

export interface ProfilableNodeOutput {
  node: GraphNode;
  output: PortDef;
  hasConnectedInputs: boolean;
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
    if (n.type === GROUP_TYPE || n.type === GROUP_INPUT_TYPE || n.type === GROUP_OUTPUT_TYPE) return false;
    return def.nodeClass !== "shader" && def.nodeClass !== "output";
  });
}

export function profilableNodeOutputs(
  doc: MaterialGraphDocument,
  registry: NodeRegistry,
  only?: string[],
): ProfilableNodeOutput[] {
  const filter = only && only.length ? new Set(only) : null;
  const targets: ProfilableNodeOutput[] = [];
  const visit = (current: MaterialGraphDocument): void => {
    for (const node of current.nodes) {
      if (node.type === GROUP_TYPE && node.subgraph) visit(node.subgraph);
      if (node.enabled === false || (filter && !filter.has(node.id)) || !registry.has(node.type)) continue;
      if (node.type === GROUP_TYPE || node.type === GROUP_INPUT_TYPE || node.type === GROUP_OUTPUT_TYPE) continue;
      const def = registry.get(node.type);
      if (def.nodeClass === "shader" || def.nodeClass === "output") continue;
      const hasConnectedInputs = current.edges.some((edge) => edge.toNode === node.id);
      const declaredOutputs = nodePortsForProfile(node, registry);
      const connectedOutputs = declaredOutputs.filter((output) =>
        current.edges.some((edge) => edge.fromNode === node.id && edge.fromOutput === output.key),
      );
      // Default profiling follows only code that reaches another node. An explicit nodeIds request is an
      // inspection request, so include all of that node's outputs even if one is currently disconnected.
      const outputs = filter?.has(node.id) ? declaredOutputs : connectedOutputs;
      for (const output of outputs) {
        targets.push({ node, output, hasConnectedInputs });
      }
    }
  };
  visit(doc);
  return targets;
}

export function profileWorkload(
  node: GraphNode,
  output: PortDef,
  registry: NodeRegistry,
): NodeProfileWorkload | undefined {
  return registry.has(node.type)
    ? registry.get(node.type).profileWorkload?.(node.params, output.key, "offline")
    : undefined;
}

function nodePortsForProfile(node: GraphNode, registry: NodeRegistry): PortDef[] {
  return nodePorts(node, registry).outputs.filter((output) => output.kind !== "shader");
}

export function median(samples: number[]): number {
  if (!samples.length) return 0;
  const s = [...samples].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Populate the public node-local values from controlled real-vs-baseline measurements. Negative samples are
// timing/compiler noise (or a real node cheaper than the neutral sink), so the actionable cost is clamped to 0.
export function deriveMeasuredNodeCosts(rows: NodeProfileRow[]): void {
  for (const row of rows) {
    row.compileMs = Math.max(0, row.isolatedCompileMs - row.baselineCompileMs);
    row.gpuMs = Math.max(
      0,
      row.gpuPairedDeltaMs ?? row.isolatedGpuMs - row.baselineGpuMs,
    );
  }
}
