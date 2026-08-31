import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  BakedTextureSet,
  MaterialBakeService,
  MaterialGraphRuntime,
  MaterialGraphSession,
  SURFACE_CHANNELS,
  buildMeshMaterial,
  compileGraph,
  createDefaultMaterialDocument,
  createMaterialTopologyKey,
  createMemoryCacheStore,
  defaultRegistry,
  migrateMaterialDocument,
  readArmPacking,
  readMaterialSurface,
  readOutputResolution,
  type BakeReport,
  type MaterialGraphDocument,
  type MaterialType,
  type PbrSocket,
} from "../src";
import { createBakeTimingBreakdown } from "../src/graph/bake-service";
import {
  createShaderCacheBuster,
  deriveMeasuredNodeCosts,
  measureNodeShaderMetrics,
  profilableNodeOutputs,
  profileWorkload,
  type NodeProfileRow,
} from "../src/profiling";
import { vec3 } from "three/tsl";
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

describe("bake telemetry", () => {
  it("totals generation phases without folding in serial queue wait", () => {
    const timings = createBakeTimingBreakdown(13, {
      graphCompileMs: 2,
      cacheDispatchMs: 3,
      pipelineCompileMs: 5,
      channelDispatchMs: 7,
      cacheRestoreMs: 0,
      gpuWaitMs: 11,
    });

    expect(timings.queueWaitMs).toBe(13);
    expect(timings.generationMs).toBe(28);
  });

  it("pins the additive BakeReport fields while retaining compatibility totals", () => {
    const timings = createBakeTimingBreakdown(0, {
      graphCompileMs: 4,
      channelDispatchMs: 6,
      gpuWaitMs: 8,
    });
    const report: BakeReport = {
      runId: 1,
      source: "asphalt",
      phase: "done",
      nodeCount: 31,
      resolution: 1024,
      channels: ["baseColor", "roughness", "normal", "height"],
      timings,
      compileMs: timings.graphCompileMs,
      texturesTotal: 4,
      totalMs: timings.generationMs,
    };

    expect(report.resolution).toBe(1024);
    expect(report.channels).toEqual(["baseColor", "roughness", "normal", "height"]);
    expect(report.compileMs).toBe(report.timings.graphCompileMs);
    expect(report.totalMs).toBe(report.timings.generationMs);
    expect(report.texturesTotal).toBe(report.channels.length);
  });
});

describe("cold benchmark shader identity", () => {
  it("emits the same WGSL identity within one run and a different one for the next run", () => {
    const runA1 = createShaderCacheBuster("run-a")!.vec3(vec3(0.1, 0.2, 0.3));
    const runA2 = createShaderCacheBuster("run-a")!.vec3(vec3(0.1, 0.2, 0.3));
    const runB = createShaderCacheBuster("run-b")!.vec3(vec3(0.1, 0.2, 0.3));
    const wgsl = (node: { functionNode: { code: string } }): string => node.functionNode.code;

    expect(wgsl(runA1)).toBe(wgsl(runA2));
    expect(wgsl(runA1)).not.toBe(wgsl(runB));
    expect(wgsl(runA1)).toContain("guard *");
  });
});

describe("node profile measurement", () => {
  it("profiles dynamic node outputs port-for-port", () => {
    const document: MaterialGraphDocument = {
      version: 4,
      nodes: [
        {
          id: "cells",
          type: "voronoi",
          params: { feature: "distance-to-edge" },
          enabled: true,
        },
      ],
      edges: [],
    };

    expect(profilableNodeOutputs(document, defaultRegistry, ["cells"]).map(({ output }) => output.key)).toEqual([
      "distance",
      "edges",
      "random",
    ]);
  });

  it("derives measured node-local deltas from matched isolated baselines", () => {
    const row = (
      nodeId: string,
      isolatedCompileMs: number,
      baselineCompileMs: number,
      isolatedGpuMs: number,
      baselineGpuMs: number,
    ): NodeProfileRow => ({
      nodeId,
      type: "constant-field",
      outputKey: "field",
      outputKind: "float",
      graphCompileMs: 0,
      isolatedGraphCompileMs: 0,
      subtreeCompileMs: 20,
      subtreeGpuMs: 10,
      isolatedCompileMs,
      isolatedGpuMs,
      baselineCompileMs,
      baselineGpuMs,
      compileMs: 0,
      gpuMs: 0,
    });
    const rows = [row("source", 10, 2, 5, 1), row("consumer", 15, 10, 9, 5)];
    deriveMeasuredNodeCosts(rows);

    expect(rows[0].compileMs).toBe(8);
    expect(rows[0].gpuMs).toBe(4);
    expect(rows[1].compileMs).toBe(5);
    expect(rows[1].gpuMs).toBe(4);
  });

  it("uses the interleaved paired GPU delta instead of drifting independent medians", () => {
    const row: NodeProfileRow = {
      nodeId: "paired",
      type: "constant-field",
      outputKey: "field",
      outputKind: "float",
      graphCompileMs: 0,
      isolatedGraphCompileMs: 0,
      subtreeCompileMs: 0,
      subtreeGpuMs: 0,
      isolatedCompileMs: 12,
      isolatedGpuMs: 0.4,
      baselineCompileMs: 4,
      baselineGpuMs: 0.6,
      compileMs: 0,
      gpuPairedDeltaMs: 0.25,
      gpuMs: 0,
    };
    deriveMeasuredNodeCosts([row]);
    expect(row.compileMs).toBe(8);
    expect(row.gpuMs).toBe(0.25);
  });

  it("calculates the selected tileable-noise primitive workload", () => {
    const stone = {
      id: "stone",
      type: "tileable-noise",
      params: { noiseType: "perlin-fbm", preset: "stone", octaves: 6, tileSize: "512" },
      enabled: true,
    };
    const value = {
      id: "value",
      type: "tileable-noise",
      params: { noiseType: "value", preset: "none", octaves: 6, tileSize: "off" },
      enabled: true,
    };
    const output = { key: "field", kind: "float" as const };

    expect(profileWorkload(stone, output)).toMatchObject({
      kernel: "stone",
      configuredTileSize: 512,
      totalPrimitiveEvaluations: 30,
    });
    expect(profileWorkload(value, output)).toMatchObject({
      kernel: "value",
      totalPrimitiveEvaluations: 24,
    });
    stone.params.preset = "stone-analytic";
    expect(profileWorkload(stone, output)).toMatchObject({
      kernel: "stone-analytic",
      totalPrimitiveEvaluations: 12,
    });
  });

  it("calculates output-specific Voronoi search work", () => {
    const node = {
      id: "cells",
      type: "voronoi",
      params: { feature: "distance-to-edge", relax: 0 },
      enabled: true,
    };
    expect(profileWorkload(node, { key: "distance", kind: "float" })?.totalPrimitiveEvaluations).toBe(54);
    expect(profileWorkload(node, { key: "random", kind: "float" })?.totalPrimitiveEvaluations).toBe(27);
    node.params.relax = 3;
    expect(profileWorkload(node, { key: "edges", kind: "float" })?.totalPrimitiveEvaluations).toBe(18);
    expect(profileWorkload(node, { key: "random", kind: "float" })?.totalPrimitiveEvaluations).toBe(10);
    node.params.feature = "distance-to-edge-2d";
    node.params.relax = 0;
    expect(profileWorkload(node, { key: "edges", kind: "float" })).toMatchObject({
      kernel: "distance-to-edge-2d",
      totalPrimitiveEvaluations: 18,
    });
    expect(profileWorkload(node, { key: "random", kind: "float" })?.totalPrimitiveEvaluations).toBe(9);
  });

  it("measures isolated WGSL growth against its matched baseline", () => {
    const metrics = measureNodeShaderMetrics(
      "fn helper() -> f32 { return 1.0; }\nfn main() { for (var i = 0; i < 2; i++) {} }",
      "fn main() {}",
    );
    expect(metrics.fragmentByteDelta).toBeGreaterThan(0);
    expect(metrics.isolatedFunctionCount).toBe(2);
    expect(metrics.baselineFunctionCount).toBe(1);
    expect(metrics.isolatedLoopCount).toBe(1);
  });
});

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
    expect(migrated.version).toBe(4);
    const node = migrated.nodes.find((n) => n.id === "pr")!;
    expect(node.type).toBe("shader-material");
    expect(node.params.materialType).toBe("physical");
    expect(node.params.roughness).toBe(0.3); // legacy params preserved verbatim
    expect(legacy.nodes[0]!.type).toBe("principled-bsdf"); // migration doesn't mutate the input
  });

  it("migrates a legacy tileable-noise composition to perlin-fbm + preset (v4)", () => {
    const legacy: MaterialGraphDocument = {
      version: 3,
      nodes: [
        { id: "n", type: "tileable-noise", params: { noiseType: "erosion", scale: 7 }, position: { x: 0, y: 0 }, enabled: true },
        { id: "out", type: "material-output", params: {}, position: { x: 320, y: 0 }, enabled: true },
      ],
      edges: [],
    };
    const migrated = migrateMaterialDocument(legacy);
    expect(migrated.version).toBe(4);
    const node = migrated.nodes.find((n) => n.id === "n")!;
    expect(node.params.noiseType).toBe("perlin-fbm"); // composition re-homed onto the Perlin algorithm
    expect(node.params.preset).toBe("erosion"); // original selection preserved as a preset
    expect(node.params.scale).toBe(7); // other params preserved verbatim
    expect(legacy.nodes[0]!.params.noiseType).toBe("erosion"); // migration doesn't mutate the input
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
    const lambert = compileGraph(materialDoc("lambert"), defaultRegistry, { backend: "live" })
      .material as unknown as Record<string, unknown>;
    expect(lambert.roughnessNode == null).toBe(true);
    expect(lambert.metalnessNode == null).toBe(true);
    const physical = compileGraph(materialDoc("physical"), defaultRegistry, { backend: "live" })
      .material as unknown as Record<string, unknown>;
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

describe("buildMeshMaterial (classic material reconstruction)", () => {
  const noTextures = { get: () => null };
  const allTextures = (() => {
    const t = new THREE.Texture();
    return { get: () => t };
  })();

  it("builds the classic Three.js class for each materialType", () => {
    const cases: Array<[MaterialType, new () => THREE.Material]> = [
      ["standard", THREE.MeshStandardMaterial],
      ["physical", THREE.MeshPhysicalMaterial],
      ["lambert", THREE.MeshLambertMaterial],
      ["toon", THREE.MeshToonMaterial],
      ["phong", THREE.MeshPhongMaterial],
      ["matcap", THREE.MeshMatcapMaterial],
    ];
    for (const [type, cls] of cases) {
      expect(buildMeshMaterial(materialDoc(type), noTextures), type).toBeInstanceOf(cls);
    }
    // Physical extends Standard — a "standard" doc must NOT be a Physical material.
    expect(buildMeshMaterial(materialDoc("standard"), noTextures)).not.toBeInstanceOf(THREE.MeshPhysicalMaterial);
  });

  it("wires present channels to the standard map slots with identity scalars", () => {
    const m = buildMeshMaterial(materialDoc("standard"), allTextures) as THREE.MeshStandardMaterial;
    expect(m.map).not.toBeNull();
    expect(m.roughnessMap).not.toBeNull();
    expect(m.metalnessMap).not.toBeNull();
    expect(m.normalMap).not.toBeNull();
    expect(m.aoMap).not.toBeNull();
    expect(m.roughness).toBe(1); // map carries the value — multiplier stays 1
    expect(m.metalness).toBe(1);
  });

  it("falls back to document scalars when channels are absent", () => {
    const doc = materialDoc("physical");
    doc.nodes[0]!.params.roughness = 0.25;
    doc.nodes[0]!.params.ior = 1.8;
    doc.nodes[0]!.params.coat = 0.5;
    const m = buildMeshMaterial(doc, noTextures) as THREE.MeshPhysicalMaterial;
    expect(m.roughnessMap).toBeNull();
    expect(m.roughness).toBe(0.25);
    expect(m.ior).toBeCloseTo(1.8);
    expect(m.clearcoat).toBe(0.5); // physical lobe loaded from the param (no baked channel)
  });

  it("loads phong shininess and toon gradient map", () => {
    const phongDoc = materialDoc("phong");
    phongDoc.nodes[0]!.params.shininess = 80;
    const phong = buildMeshMaterial(phongDoc, noTextures) as THREE.MeshPhongMaterial;
    expect(phong.shininess).toBe(80);

    const toon = buildMeshMaterial(materialDoc("toon"), noTextures) as THREE.MeshToonMaterial;
    expect(toon.gradientMap).not.toBeNull();
  });
});

describe("tile per-cell outputs + vector-rotate", () => {
  // tile.cellCoord → Vector Rotate (angle from tile.cellRandom) → noise → height. This is the per-cell
  // oriented-detail path the board-formed concrete port needs; it must compile in both backends.
  function perCellRotationDoc(lattice: "square" | "hex"): MaterialGraphDocument {
    return {
      version: 4,
      nodes: [
        { id: "uv", type: "tex-coordinate", params: {}, position: { x: 0, y: 0 }, enabled: true },
        { id: "tl", type: "tile", params: { lattice, columns: 4, rows: 4 }, position: { x: 0, y: 0 }, enabled: true },
        { id: "vr", type: "vector-rotate", params: { axis: "z" }, position: { x: 0, y: 0 }, enabled: true },
        { id: "nz", type: "tileable-noise", params: { scale: 8 }, position: { x: 0, y: 0 }, enabled: true },
        { id: "mat", type: "shader-material", params: { materialType: "physical" }, position: { x: 0, y: 0 }, enabled: true },
        { id: "out", type: "material-output", params: {}, position: { x: 0, y: 0 }, enabled: true },
      ],
      edges: [
        { fromNode: "uv", fromOutput: "uv", toNode: "tl", toInput: "coord" },
        { fromNode: "tl", fromOutput: "cellCoord", toNode: "vr", toInput: "vector" },
        // vector → float coercion (average) turns the per-cell random into a per-cell rotation angle.
        { fromNode: "tl", fromOutput: "cellRandom", toNode: "vr", toInput: "angle" },
        { fromNode: "vr", fromOutput: "vector", toNode: "nz", toInput: "coord" },
        { fromNode: "nz", fromOutput: "field", toNode: "mat", toInput: "height" },
        { fromNode: "mat", fromOutput: "bsdf", toNode: "out", toInput: "surface" },
      ],
    };
  }

  it("registers cellCoord/cellRandom as vector outputs on the tile node", () => {
    const outs = defaultRegistry.get("tile").outputs;
    expect(outs.map((o) => o.key)).toEqual(["mask", "value", "cellCoord", "cellRandom"]);
    expect(outs.find((o) => o.key === "cellCoord")!.kind).toBe("vector");
    expect(outs.find((o) => o.key === "cellRandom")!.kind).toBe("vector");
    // mask/value stay first so existing presets keep resolving the same sockets.
    expect(outs[0]!.kind).toBe("float");
    expect(outs[1]!.kind).toBe("float");
  });

  it("exposes vector-rotate with a vector output and an angle input", () => {
    const def = defaultRegistry.get("vector-rotate");
    expect(def.outputs).toEqual([{ key: "vector", kind: "vector" }]);
    expect(def.inputs.map((i) => i.key)).toEqual(["vector", "center", "angle"]);
    expect(def.inputs.find((i) => i.key === "angle")!.kind).toBe("float");
  });

  it("compiles the per-cell rotation graph in both backends (square lattice)", () => {
    for (const backend of ["live", "offline"] as const) {
      const { material } = compileGraph(perCellRotationDoc("square"), defaultRegistry, { backend });
      expect(material, backend).toBeInstanceOf(MeshPhysicalNodeMaterial);
    }
  });

  it("compiles the per-cell rotation graph for the hex lattice", () => {
    const { material } = compileGraph(perCellRotationDoc("hex"), defaultRegistry, { backend: "offline" });
    expect(material).toBeInstanceOf(MeshPhysicalNodeMaterial);
  });

  it("still compiles a tile graph that only uses mask/value (back-compat)", () => {
    const doc: MaterialGraphDocument = {
      version: 4,
      nodes: [
        { id: "tl", type: "tile", params: { lattice: "square", columns: 6, rows: 12 }, position: { x: 0, y: 0 }, enabled: true },
        { id: "mat", type: "shader-material", params: { materialType: "physical" }, position: { x: 0, y: 0 }, enabled: true },
        { id: "out", type: "material-output", params: {}, position: { x: 0, y: 0 }, enabled: true },
      ],
      edges: [
        { fromNode: "tl", fromOutput: "mask", toNode: "mat", toInput: "height" },
        { fromNode: "mat", fromOutput: "bsdf", toNode: "out", toInput: "surface" },
      ],
    };
    expect(() => compileGraph(doc, defaultRegistry, { backend: "offline" })).not.toThrow();
  });
});

describe("ARM packing", () => {
  it("reads packArm as ON for sparse documents and coerces explicit/string forms", () => {
    const doc = materialDoc("physical");
    expect(readArmPacking(doc)).toBe(true); // sparse params — every pre-existing document opts in

    doc.nodes[1]!.params.packArm = true;
    expect(readArmPacking(doc)).toBe(true);
    doc.nodes[1]!.params.packArm = false;
    expect(readArmPacking(doc)).toBe(false);
    doc.nodes[1]!.params.packArm = "false"; // MCP set_param may deliver strings
    expect(readArmPacking(doc)).toBe(false);
    doc.nodes[1]!.params.packArm = "true";
    expect(readArmPacking(doc)).toBe(true);
  });

  it("aliases the three field sockets AND height to ONE shared ARMH texture when packed", () => {
    const set = new BakedTextureSet(64, SURFACE_CHANNELS);
    const arm = set.ensureArmTarget();
    set.target("baseColor"); // baseColor keeps its own target either way
    const present = new Set<PbrSocket>(["baseColor", "roughness", "metallic", "ambientOcclusion"]);
    set.setPresence(present, true, true); // hasHeight: packed height rides the arm alpha

    expect(set.texture("roughness")).toBe(arm.texture);
    expect(set.texture("metallic")).toBe(arm.texture);
    expect(set.texture("ambientOcclusion")).toBe(arm.texture);
    expect(set.heightTexture()).toBe(arm.texture); // ARMH: A carries the height field
    expect(set.texture("baseColor")).not.toBe(arm.texture);
    expect(set.texture("baseColor")).not.toBeNull();
    // A socket that wasn't present at the bake stays null even though packed texels exist for its slot —
    // and a graph with no height keeps heightTexture() null.
    set.setPresence(new Set<PbrSocket>(["roughness", "metallic"]), false, true);
    expect(set.texture("ambientOcclusion")).toBeNull();
    expect(set.heightTexture()).toBeNull();
    // Unpacked, the dedicated height target is the source again.
    const heightRt = set.ensureHeightTarget();
    set.setPresence(new Set<PbrSocket>(["roughness", "metallic"]), true, false);
    expect(set.heightTexture()).toBe(heightRt.texture);
    set.dispose();
  });

  it("reports a signature change when only the pack flag toggles (forces a rewire)", () => {
    const set = new BakedTextureSet(64, SURFACE_CHANNELS);
    const present = new Set<PbrSocket>(["roughness", "metallic", "ambientOcclusion"]);
    expect(set.setPresence(present, false, true)).toBe(true); // first presence
    expect(set.setPresence(present, false, true)).toBe(false); // unchanged
    expect(set.setPresence(present, false, false)).toBe(true); // pack toggle alone must rewire
    set.dispose();
  });

  it("hydrates a cached 'arm' record as the SAME texture for every field socket", async () => {
    const size = 8;
    const bytes = size * size * 4;
    const runtime = new MaterialGraphRuntime({
      document: materialDoc("physical"),
      bakeService: new MaterialBakeService(), // own service so the shared singleton's cache isn't touched
      cache: { store: createMemoryCacheStore(), enabled: true },
    });
    await runtime.cache!.write(runtime.cacheKey(), {
      size,
      channels: ["baseColor", "roughness", "metallic", "ambientOcclusion"],
      // ARMH: no separate "height" texel entry — the flag alone says height rides the arm alpha.
      hasHeight: true,
      bakeMs: 1000,
      textures: [
        { channel: "baseColor", encoding: "rgba8", bytes: new Uint8Array(bytes).fill(3) },
        { channel: "arm", encoding: "rgba8", bytes: new Uint8Array(bytes).fill(9) },
      ],
    });

    const cached = await runtime.loadCachedChannelTextures();
    expect(cached).not.toBeNull();
    const rough = cached!.get("roughness");
    expect(rough).not.toBeNull();
    expect(cached!.get("metallic")).toBe(rough);
    expect(cached!.get("ambientOcclusion")).toBe(rough);
    expect(cached!.height).toBe(rough); // ARMH: the height slot is the same packed texture (alpha)
    expect(cached!.get("baseColor")).not.toBe(rough);
    // The shared texture is mapped under four slots — dispose must dedupe, not quadruple-dispose.
    expect(() => cached!.dispose()).not.toThrow();
  });
});
