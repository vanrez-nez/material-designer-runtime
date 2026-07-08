import type * as THREE from "three";
import type { NodeMaterial, WebGPURenderer } from "three/webgpu";
import { MaterialGraphSession } from "./document";
import { MaterialBakeService, bakeService } from "./graph/bake-service";
import { TexturedSurface } from "./graph/textured-surface";
import { buildMeshMaterial } from "./graph/mesh-material";
import type { MaterialGraphDocument } from "./graph/types";
import { defaultRegistry, type NodeRegistry } from "./graph/registry";

export interface MaterialGraphRuntimeOptions {
  document?: MaterialGraphDocument;
  registry?: NodeRegistry;
  bakeService?: MaterialBakeService;
  source?: string;
}

export class MaterialGraphRuntime {
  readonly graph: MaterialGraphSession;
  readonly surface: TexturedSurface;
  readonly service: MaterialBakeService;

  constructor(options: MaterialGraphRuntimeOptions = {}) {
    this.service = options.bakeService ?? bakeService;
    this.graph = new MaterialGraphSession(options.document, options.registry ?? defaultRegistry);
    this.surface = new TexturedSurface(this.graph, this.service, options.source);
  }

  // The TSL node material for the document's family (MeshStandard/Physical/…NodeMaterial), with the full
  // procedural fidelity: triplanar, parallax-occlusion, per-vertex AO, and procedurally-driven lobes. Renders
  // on a WebGPURenderer. Its object may change across re-bakes (family/backend switch) — re-read on onRebuilt.
  getNodeMaterial(): NodeMaterial {
    return this.surface.material;
  }

  // A CLASSIC Three.js material (MeshStandardMaterial/MeshPhysicalMaterial/…) with the baked channel textures
  // wired to the standard map slots and every scalar/setting loaded from the document — nothing to copy by
  // hand. Call after refresh() so the channels are baked. Drops the node-only features (triplanar / parallax /
  // procedural lobes); see buildMeshMaterial. Built fresh per call: the maps are the stable baked textures so
  // channel re-bakes reflect automatically, but a material-family or scalar change needs another call.
  // Its `.aoMap` samples the mesh's 2nd UV set — replicate uv0→uv1 on your geometry.
  getMeshMaterial(): THREE.Material {
    return buildMeshMaterial(this.graph.document, { get: (ch) => this.surface.getChannelTexture(ch) });
  }

  // Free intermediate bake caches after a final refresh(); keeps the sampled channel maps. Bake-once
  // consumers call this once at load to reclaim the re-bake cache GPU memory they'll never use.
  releaseCaches(): Promise<void> {
    return this.surface.releaseCaches();
  }

  get lastError(): string | null {
    return this.surface.lastError ?? this.graph.lastError;
  }

  // True while a bake is in flight (covers the whole rebuild, incl. the in-place texture resize). Gate a
  // render loop on `!runtime.busy` so it never submits a frame mid-bake.
  get busy(): boolean {
    return this.surface.busy;
  }

  // Resolves once the runtime is done baking (immediately when idle). Useful after edits that trigger an
  // implicit re-bake (setNodeParam / setOutputResolution) where there's no explicit refresh() to await.
  whenIdle(): Promise<void> {
    return this.surface.whenIdle();
  }

  setRenderer(renderer: WebGPURenderer): this {
    this.service.attachRenderer(renderer);
    return this;
  }

  fromDocument(document: MaterialGraphDocument): this {
    return this.setDocument(document);
  }

  setDocument(document: MaterialGraphDocument): this {
    this.graph.setDocument(document);
    return this;
  }

  getDocument(): MaterialGraphDocument {
    return this.graph.getDocument();
  }

  setOutputResolution(size: number): this {
    this.graph.setOutputResolution(size);
    return this;
  }

  setOutputTargets(targets: { resolution?: number; size?: number }): this {
    this.graph.setOutputTargets(targets);
    return this;
  }

  setNodeParam(nodeId: string, key: string, value: unknown): this {
    this.graph.setNodeParam(nodeId, key, value);
    return this;
  }

  updateNodeParams(nodeId: string, patch: Record<string, unknown>): this {
    this.graph.updateNodeParams(nodeId, patch);
    return this;
  }

  refresh(): Promise<void> {
    return this.surface.refresh();
  }

  regenerate(): this {
    this.surface.regenerate();
    return this;
  }

  dispose(): void {
    this.surface.dispose();
  }
}
