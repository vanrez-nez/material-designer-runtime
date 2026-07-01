import { describe, expect, it } from "vitest";
import {
  MaterialGraphSession,
  createDefaultMaterialDocument,
  createMaterialTopologyKey,
  defaultRegistry,
  readOutputResolution,
  type MaterialGraphDocument,
} from "../src";

function constantDoc(): MaterialGraphDocument {
  return {
    version: 2,
    nodes: [
      {
        id: "constant",
        type: "constant-field",
        params: { value: 0.5 },
        position: { x: 0, y: 0 },
        enabled: true,
      },
      {
        id: "bsdf",
        type: "principled-bsdf",
        params: {},
        position: { x: 320, y: 0 },
        enabled: true,
      },
      {
        id: "out",
        type: "material-output",
        params: { outputResolution: "1024" },
        position: { x: 640, y: 0 },
        enabled: true,
      },
    ],
    edges: [
      { fromNode: "constant", fromOutput: "field", toNode: "bsdf", toInput: "roughness" },
      { fromNode: "bsdf", fromOutput: "bsdf", toNode: "out", toInput: "surface" },
    ],
  };
}

describe("material runtime document session", () => {
  it("loads the default graph and exposes output resolution", () => {
    const doc = createDefaultMaterialDocument();
    const graph = new MaterialGraphSession(doc);
    expect(graph.document.nodes.length).toBeGreaterThan(0);
    expect(readOutputResolution(graph.document)).toBeGreaterThan(0);
  });

  it("emits direct param changes for live tweakable params", () => {
    const doc = constantDoc();
    const graph = new MaterialGraphSession(doc);
    const changes: string[] = [];
    graph.onChange((change) => changes.push(change.kind));
    expect(graph.setNodeParam("constant", "value", 0.42)).toBe(true);
    expect(changes).toEqual(["param"]);
  });

  it("keeps topology stable for live tweakable params", () => {
    const doc = constantDoc();
    const before = createMaterialTopologyKey(doc, defaultRegistry);
    doc.nodes[0]!.params.value = 0.67;
    const after = createMaterialTopologyKey(doc, defaultRegistry);
    expect(after).toBe(before);
  });

  it("changes topology for output resolution changes", () => {
    const doc = createDefaultMaterialDocument();
    const before = createMaterialTopologyKey(doc, defaultRegistry);
    const graph = new MaterialGraphSession(doc);
    graph.setOutputResolution(512);
    const after = createMaterialTopologyKey(graph.document, defaultRegistry);
    expect(after).not.toBe(before);
  });
});
