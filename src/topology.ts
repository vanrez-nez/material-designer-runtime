import { nodePorts, type NodeRegistry } from "./graph/registry";
import type { GraphNode, MaterialGraphDocument } from "./graph/types";

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
