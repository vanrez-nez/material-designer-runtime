import { describe, expect, it } from "vitest";
import {
  MaterialGraphSession,
  compileGraph,
  createDefaultMaterialDocument,
  createMaterialTopologyKey,
  defaultRegistry,
  migrateMaterialDocument,
  readMaterialSurface,
  readOutputResolution,
  type MaterialGraphDocument,
  type MaterialType,
} from "../src";
import {
  MeshStandardNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshLambertNodeMaterial,
  MeshToonNodeMaterial,
  MeshPhongNodeMaterial,
  MeshMatcapNodeMaterial,
} from "three/webgpu";

// A minimal shader-material → output document for a given family.
function materialDoc(materialType: MaterialType): MaterialGraphDocument {
  return {
    version: 3,
    nodes: [
      { id: "mat", type: "shader-material", params: { materialType }, position: { x: 0, y: 0 }, enabled: true },
      { id: "out", type: "material-output", params: {}, position: { x: 320, y: 0 }, enabled: true },
    ],
    edges: [{ fromNode: "mat", fromOutput: "bsdf", toNode: "out", toInput: "surface" }],
  };
}

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

describe("material type transport", () => {
  it("migrates a legacy principled-bsdf document to shader-material (v3)", () => {
    const legacy: MaterialGraphDocument = {
      version: 2,
      nodes: [
        { id: "pr", type: "principled-bsdf", params: { roughness: 0.3 }, position: { x: 0, y: 0 }, enabled: true },
        { id: "out", type: "material-output", params: {}, position: { x: 320, y: 0 }, enabled: true },
      ],
      edges: [{ fromNode: "pr", fromOutput: "bsdf", toNode: "out", toInput: "surface" }],
    };
    const migrated = migrateMaterialDocument(legacy);
    expect(migrated.version).toBe(3);
    const node = migrated.nodes.find((n) => n.id === "pr")!;
    expect(node.type).toBe("shader-material");
    expect(node.params.materialType).toBe("physical");
    expect(node.params.roughness).toBe(0.3); // legacy params preserved verbatim
    expect(legacy.nodes[0]!.type).toBe("principled-bsdf"); // migration doesn't mutate the input
  });

  it("compiles each materialType to its THREE node material class", () => {
    const cases: Array<[MaterialType, new () => object]> = [
      ["standard", MeshStandardNodeMaterial],
      ["physical", MeshPhysicalNodeMaterial],
      ["lambert", MeshLambertNodeMaterial],
      ["toon", MeshToonNodeMaterial],
      ["phong", MeshPhongNodeMaterial],
      ["matcap", MeshMatcapNodeMaterial],
    ];
    for (const [type, cls] of cases) {
      const { material } = compileGraph(materialDoc(type), defaultRegistry, { backend: "live" });
      expect(material, type).toBeInstanceOf(cls);
    }
    // Physical extends Standard, so guard the reverse: a "standard" graph must NOT be a Physical material.
    const std = compileGraph(materialDoc("standard"), defaultRegistry, { backend: "live" }).material;
    expect(std).not.toBeInstanceOf(MeshPhysicalNodeMaterial);
  });

  it("omits roughness/metalness channels for non-PBR families", () => {
    const lambert = compileGraph(materialDoc("lambert"), defaultRegistry, { backend: "live" }).material as Record<
      string,
      unknown
    >;
    expect(lambert.roughnessNode == null).toBe(true);
    expect(lambert.metalnessNode == null).toBe(true);
    const physical = compileGraph(materialDoc("physical"), defaultRegistry, { backend: "live" }).material as Record<
      string,
      unknown
    >;
    expect(physical.roughnessNode != null).toBe(true); // PBR family keeps the metal workflow
  });

  it("reads material type + phong settings from the document", () => {
    const doc = materialDoc("phong");
    doc.nodes[0]!.params.shininess = 80;
    doc.nodes[0]!.params.specular = "#223344";
    const { type, settings } = readMaterialSurface(doc);
    expect(type).toBe("phong");
    expect(settings.shininess).toBe(80);
    expect(settings.specular).toBe("#223344");
  });

  it("falls back to physical for a non-shader-material terminal (back-compat)", () => {
    expect(readMaterialSurface(constantDoc()).type).toBe("physical");
  });
});
