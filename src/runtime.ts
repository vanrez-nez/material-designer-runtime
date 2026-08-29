import type * as THREE from "three";
import type { NodeMaterial, WebGPURenderer } from "three/webgpu";
import { MaterialGraphSession } from "./document";
import { MaterialBakeService, SURFACE_CHANNELS, bakeService } from "./graph/bake-service";
import { TexturedSurface } from "./graph/textured-surface";
import { buildMeshMaterial, type ChannelTextures } from "./graph/mesh-material";
import { channelDataTexture } from "./graph/texture-transfer";
import type { MaterialGraphDocument, PbrSocket } from "./graph/types";
import { defaultRegistry, type NodeRegistry } from "./graph/registry";
import { BakeTextureCache } from "./cache/bake-cache";
import type { BakeCacheEntryMeta, BakeCacheMetrics, BakeCacheOptions } from "./cache/types";
import type { BakeCacheKey } from "./cache/key";

// Cache-hydrated channel textures. Satisfies ChannelTextures so it drops straight into buildMeshMaterial, and
// adds the height map (not a lit channel, so not part of that interface) plus the disposal the caller owns.
export interface CachedChannelTextures extends ChannelTextures {
  size: number;
  channels: PbrSocket[];
  height: THREE.Texture | null;
  dispose(): void;
}

export interface MaterialGraphRuntimeOptions {
  document?: MaterialGraphDocument;
  registry?: NodeRegistry;
  bakeService?: MaterialBakeService;
  source?: string;
  // Benchmark/diagnostic only. A different value changes the actual WGSL identity for bake and visible
  // surface shaders without changing their output, defeating cross-reload shader/pipeline cache hits.
  shaderCacheNonce?: string;
  // Cross-session baked-texture cache. OPT-IN: omit it (or pass false) and nothing is persisted and no
  // storage is touched. Pass options to get the built-in IndexedDB store, or a BakeTextureCache you built
  // around your own BakeCacheStore.
  //
  // The cache is installed on the BAKE SERVICE, which is a page-wide singleton unless you injected your own
  // via `bakeService`. That sharing is deliberate: entries are content-addressed, so two runtimes holding the
  // same document should hit the same entry. Pass your own `bakeService` if you want isolation.
  cache?: BakeTextureCache | BakeCacheOptions | false;
}

export class MaterialGraphRuntime {
  readonly graph: MaterialGraphSession;
  readonly surface: TexturedSurface;
  readonly service: MaterialBakeService;

  constructor(options: MaterialGraphRuntimeOptions = {}) {
    this.service = options.bakeService ?? bakeService;
    this.graph = new MaterialGraphSession(options.document, options.registry ?? defaultRegistry);
    this.surface = new TexturedSurface(
      this.graph,
      this.service,
      options.source,
      options.shaderCacheNonce,
    );
    if (options.cache instanceof BakeTextureCache) {
      this.service.setCache(options.cache);
    } else if (options.cache) {
      // Options given without `enabled` still mean "I want this on" — configuring a cache and having it stay
      // dormant would be a trap.
      this.service.setCache(new BakeTextureCache({ enabled: true, ...options.cache }));
    }
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

  // --- persistent texture cache -------------------------------------------------------------------
  // Opt-in, cross-session cache of the baked channel texels. A hit short-circuits ahead of the shader
  // compile — the dominant cost of a bake — so a reload of an unchanged document skips it entirely.
  //
  // Everything here is a thin forward to the cache installed on the bake service; use `runtime.cache`
  // directly for the full surface (events, budget, gc, eviction).
  get cache(): BakeTextureCache | null {
    return this.service.cache;
  }

  // Turn caching on or off. Enabling with no cache installed creates the default one (IndexedDB where
  // available, otherwise in-memory) — so opting in is a single call.
  setCacheEnabled(on: boolean): this {
    const existing = this.service.cache;
    if (existing) {
      existing.setEnabled(on);
      return this;
    }
    if (on) this.service.setCache(new BakeTextureCache({ enabled: true }));
    return this;
  }

  get cacheEnabled(): boolean {
    return this.service.cache?.enabled ?? false;
  }

  // Drop every cached bake, this document's and everyone else's.
  clearCache(): Promise<void> {
    return this.service.cache?.clear() ?? Promise.resolve();
  }

  // Re-bake this document for real and replace its cached entry. Resolves only once the new entry is durably
  // written, so "rebuild the cache" actually means the cache is rebuilt when you get control back.
  async rebuildCache(): Promise<void> {
    const cache = this.service.cache;
    if (!cache) return;
    await cache.delete(this.cacheKey());
    // regenerate() bypasses the cache READ for exactly one rebuild, so this is a genuine bake.
    this.surface.regenerate();
    await this.surface.whenIdle();
    await this.service.flushCacheWrites();
  }

  // The cached entry for this document at its current bake size, or null if there isn't one. Metadata only
  // (size, channels, bytes, timestamps) — reading it does not decode any texels.
  getCachedTextures(): Promise<BakeCacheEntryMeta | null> {
    return this.service.cache?.peek(this.cacheKey()) ?? Promise.resolve(null);
  }

  // Every cached entry's metadata, newest use first — for a cache-management UI.
  async listCachedTextures(): Promise<BakeCacheEntryMeta[]> {
    const entries = (await this.service.cache?.entries()) ?? [];
    return entries.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  // This document's cached channels as real, sampleable textures — null if nothing is cached for it.
  //
  // Works with NO renderer attached, which is the point: a page that ships a fixed material can put the baked
  // maps on a plain THREE material without ever compiling a shader or baking. The result satisfies
  // ChannelTextures, so it goes straight into buildMeshMaterial:
  //
  //   const cached = await runtime.loadCachedChannelTextures();
  //   const material = cached ? buildMeshMaterial(runtime.getDocument(), cached) : await bakeTheSlowWay();
  //
  // YOU own the returned textures — call `dispose()` when the material is done with them. They are
  // independent of the live surface's baked targets, so disposing them can't disturb it.
  async loadCachedChannelTextures(): Promise<CachedChannelTextures | null> {
    const cache = this.service.cache;
    if (!cache) return null;
    const entry = await cache.read(this.cacheKey());
    if (!entry) return null;
    const map = new Map<PbrSocket, THREE.DataTexture>();
    let height: THREE.DataTexture | null = null;
    for (const texels of entry.textures) {
      const tex = channelDataTexture(texels.bytes, entry.size, texels.channel);
      if (texels.channel === "height") height = tex;
      else map.set(texels.channel, tex);
    }
    return {
      size: entry.size,
      channels: [...map.keys()],
      height,
      get: (channel) => map.get(channel) ?? null,
      dispose: () => {
        for (const tex of map.values()) tex.dispose();
        height?.dispose();
        map.clear();
        height = null;
      },
    };
  }

  // Cache size and effectiveness: entry count, total bytes, budget, hit/miss/write/evict counters, and the
  // origin's storage quota where the browser reports it. Null when no cache is installed.
  cacheMetrics(): Promise<BakeCacheMetrics | null> {
    return this.service.cacheMetrics();
  }

  // Force the deferred capture to happen now instead of after its quiet period. Useful on page unload, or in
  // a test that needs the write to be observable.
  flushCache(): Promise<void> {
    return this.service.flushCacheWrites();
  }

  // This document's cache identity at its current bake size. Exposed so a consumer integrating their own
  // storage keys it exactly as the runtime does.
  cacheKey(): BakeCacheKey {
    return this.service.cacheKeyFor(this.graph, this.surface.bakeSize, SURFACE_CHANNELS);
  }
}
