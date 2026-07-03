import type { WebGPURenderer } from "three/webgpu";
import { MaterialGraphSession } from "./document";
import { MaterialBakeService, bakeService } from "./graph/bake-service";
import { TexturedSurface } from "./graph/textured-surface";
import type { MaterialBackend, MaterialGraphDocument } from "./graph/types";
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

  get material() {
    return this.surface.material;
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

  setBackend(backend: MaterialBackend): this {
    this.surface.setBackend(backend);
    return this;
  }

  getBackend(): MaterialBackend {
    return this.surface.getBackend();
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
