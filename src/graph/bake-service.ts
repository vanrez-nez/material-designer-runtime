import * as THREE from "three";
import { RenderTarget, type WebGPURenderer, type MeshBasicNodeMaterial } from "three/webgpu";
import { vec3 } from "three/tsl";
import {
  encodeChannel,
  renderColorNodeToTarget,
  renderMaterialToTarget,
  renderCacheToTarget,
  compileMaterialsAsync,
  makeChannelMaterial,
  COLOR_CHANNELS,
} from "./channel-baker";
import { countGraphNodes, type CacheEntry, type CacheSizing, type ParamUsage } from "./compiler";
import type { MaterialGraphSource, MaterialValue, PbrSocket } from "./types";
import { uniformArray } from "three/tsl";

// Single owner of all GPU texture baking (plan: "a single pipeline manager to bake the textures").
// Decouples baking from any on-screen object: a material graph is baked into textures here, never by
// hijacking a live controller's document. Work is SERIALISED through one queue — the channel-baker uses
// shared module-level quads/RTs, so two bakes can't safely run at once anyway — and aggregate progress is
// reported (onProgress + console) so "bake N textures from different points" queues and reports as one.

// Minimal shape of the WebGPU queue's completion signal (three's backend type isn't exported here).
type GPUQueueLike = { onSubmittedWorkDone?: () => Promise<void> };

const BAKE_SIZE = 1024;
// Anisotropic-filter taps for baked channel textures (within every desktop GPU's cap; driver clamps down).
const MAX_ANISOTROPY = 8;
// Hard cap on a decomposition cache's pixel size. Keeps a supersampled derivative cache within the WebGPU
// guaranteed `maxTextureDimension2D` (8192) with headroom, and reflects that a high output already resolves
// fine grain — at output 2048 a 2× cache is 4096; at 4096 the cap makes it effectively single-sample.
const MAX_CACHE_SIZE = 4096;

// Absolute pixel size for a decomposition cache (see CacheSizing), clamped to MAX_CACHE_SIZE. An absolute
// `size` (a tiled noise's tile) wins; otherwise the bake size lifted to the `minSize` floor (the derivative /
// normal path's reference resolution — an output already ≥ it renders native). Empty/undefined → the plain
// bake size.
function cacheSizeFor(baseSize: number, sizing?: CacheSizing): number {
  const target = sizing?.size ?? Math.max(baseSize, sizing?.minSize ?? 0);
  return Math.min(target, MAX_CACHE_SIZE);
}

// A `minSize`-floored cache (the derivative/normal path) is mipmapped so a consumer at a lower resolution
// samples an area-averaged mip — a faithful downsample — instead of aliasing a single bilinear tap.
function cacheWantsMips(sizing?: CacheSizing): boolean {
  return sizing?.minSize != null;
}

// Asynchronous, off-main-thread pipeline compilation (renderer.compileAsync → createRenderPipelineAsync) is
// only reliable on Chromium/Dawn — there it lets a heavy shader compile without blocking. Firefox's WebGPU
// is early (returns a "core"-defaulting adapter, no compatibility feature level) and compiles pipelines
// SYNCHRONOUSLY on the main thread, so compileAsync there just freezes the page (and can double-compile if
// its pipeline cache key differs from the render's). On non-Chromium we therefore skip the async pre-warm
// and the render gate, and let the synchronous render compile each pipeline once.
const ASYNC_PIPELINE_COMPILE =
  typeof navigator !== "undefined" &&
  /chrome|chromium|crios|edg\//i.test(navigator.userAgent) &&
  !/firefox|fxios/i.test(navigator.userAgent);

// Dev-only bake profiling: log a per-rebuild phase breakdown to pin where the noise-slider freeze goes —
// compile (JS TSL graph) vs dispatch (6× pipeline build) vs GPU wait/exec. A structural noise param forces
// the full rebuild path; a uniform param (roughness) takes the cheap rerender baseline. Flip false / delete
// this and the renderer's `trackTimestamp` (app.ts) once characterised.
const BAKE_PROFILE = true;

// Channels a surface bakes: scalar/colour maps + tangent-space normal + emission. Height is separate (it
// drives parallax, not a lit channel) and tracked on the texture set.
export const SURFACE_CHANNELS: PbrSocket[] = [
  "baseColor", "roughness", "metallic", "ambientOcclusion", "normal", "emission",
];

// Allocate a render target configured for surface sampling (moved verbatim from OfflineMaterial.ensureTarget):
// colour channels sRGB (sampler linearises for PBR), data channels linear; repeat-wrap + trilinear/aniso
// mips so the high-frequency maps don't shimmer at grazing angles.
function makeChannelTarget(ch: PbrSocket | "height", size: number): RenderTarget {
  // Color-only bake pass — no depth test — so skip the (default) depth/stencil attachment.
  const rt = new RenderTarget(size, size, { depthBuffer: false, stencilBuffer: false });
  const t = rt.texture;
  t.colorSpace =
    ch !== "height" && COLOR_CHANNELS.includes(ch as PbrSocket) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = MAX_ANISOTROPY;
  return rt;
}

// Allocate an intermediate cache target for a decomposed group output: 16-bit float, LINEAR, repeat-wrap.
// Float precision so distance/height fields and warped coords (which exceed/clip in 8-bit) survive; linear +
// repeat so the channel bake samples it seamlessly at the tile uv. `mips` (derivative/normal path only) adds
// trilinear mipmaps so a lower-resolution consumer reads an area-averaged level — a faithful downsample of the
// reference-resolution cache instead of an aliased bilinear tap.
function makeCacheTarget(size: number, mips = false): RenderTarget {
  const rt = new RenderTarget(size, size, {
    type: THREE.HalfFloatType,
    depthBuffer: false, // color-only cache pass — no depth test
    stencilBuffer: false,
  });
  const t = rt.texture;
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  return rt;
}

export interface BakeOptions {
  channels?: PbrSocket[];
  size?: number;
  soloNodeId?: string;
  label?: string;
  // Identifies which surface this bake belongs to, so UI can scope its progress
  // readout to one material. Forwarded onto every BakeReport.
  source?: string;
}

// Per-run bake telemetry for the editor's progress widget. Emitted as a rebuild moves through its phases;
// a uniform re-render emits a "render"→"done" pair with `nodeCount` 0 (no recompile). Times are the actual
// generation work (excludes the serial-queue wait before the job starts).
export interface BakeReport {
  // Monotonic id per bake/re-render run, so a listener can detect a new run (a drag fires several).
  runId: number;
  source: string | undefined;
  // 'nodes' = rebuild started (graph compiled); 'shaders' = pipelines compiling; 'render' = uniform
  // re-render started (no recompile); 'done' = finished.
  phase: "nodes" | "shaders" | "render" | "done";
  nodeCount: number; // graph nodes recompiled (0 for a uniform re-render)
  compileMs: number; // graph (TSL) compile time
  texturesTotal: number; // channels being regenerated this run
  totalMs: number; // real generation time (incl. GPU); filled on 'done'
}

// A reusable set of baked channel textures. A live surface holds ONE and re-renders into it in place, so
// the surface keeps referencing stable texture objects and only rewires when the present-channel set
// changes. A one-off export bake gets a transient set the caller disposes.
export class BakedTextureSet {
  private readonly targets = new Map<PbrSocket, RenderTarget>();
  // Persistent per-channel bake material (colorNode assigned at compile time). Re-rendering these without
  // reassigning colorNode reuses their pipelines — the uniform fast path (no recompile on a slider drag).
  private readonly mats = new Map<PbrSocket | "height", MeshBasicNodeMaterial>();
  // Decomposition: intermediate group-output textures (16F) + their persistent bake materials, keyed by
  // cacheId. Rendered bottom-up (see `cachePlan`) BEFORE the channels, which sample them — so no channel
  // shader inlines the whole graph. `cachePlan` is retained so a uniform re-render regenerates caches in order.
  private readonly cacheTargets = new Map<string, RenderTarget>();
  private readonly cacheMats = new Map<string, MeshBasicNodeMaterial>();
  cachePlan: CacheEntry[] = [];
  // Per-node param uniforms from the last compile (nodeId -> { paramKey -> uniform node }). The colorNodes
  // above reference these, so updating a uniform's `.value` and re-rendering reflects it with no recompile.
  uniforms: Map<string, Record<string, MaterialValue>> = new Map();
  // How each node's build() consumed each param last compile (live vs constant) — the surface routes edits
  // off this (see memory: node-param-contract). Replaces the bakeStructural heuristic.
  paramUsage: ParamUsage = new Map();
  // Retention store for ctx.constantArray: pipeline-OWNED uniformArray nodes kept ACROSS bakes, keyed by
  // "nodeId/key". A same-length content change is written into the SAME node's `.array` (which uploads each
  // render), so build-time data actually reaches the GPU — three won't rebuild node-builder state on an
  // unchanged structural cache key (three.webgpu.js:30436), and a fresh array node would never be bound.
  private readonly constArrays = new Map<
    string,
    { node: MaterialValue; length: number; elementType: "float" | "vec3" }
  >();
  heightTarget: RenderTarget | null = null;
  hasHeight = false;
  // The set of channels that were actually connected at the last bake, plus a height flag — folded into a
  // signature so a surface can tell when it must rewire its samplers (vs. just re-render in place).
  present = new Set<PbrSocket>();
  signature = "";

  size: number;

  constructor(
    size: number,
    readonly channels: PbrSocket[],
  ) {
    this.size = size;
  }

  // Resize every channel/height target IN PLACE, preserving the THREE.Texture wrapper objects the live
  // surface and the 2D preview keep bound across async boundaries (recreating them makes those consumers
  // submit a freed texture — "Destroyed texture used in a submit"). `setSize` alone, though, dispose+reallocs
  // the GPU texture but leaves the mipmap chain unregenerated, so a mip/LOD-sampling consumer reads BLACK for
  // the resized channel until reload — so we also bump `texture.version` (needsUpdate) to force the backend
  // to rebuild the texture (mips included) on next use, matching a fresh allocation. Then flush the
  // size-dependent caches. No-op when the size is unchanged.
  resize(size: number): void {
    if (size === this.size) return;
    this.size = size;
    for (const rt of this.targets.values()) {
      rt.setSize(size, size);
      rt.texture.needsUpdate = true;
    }
    if (this.heightTarget) {
      this.heightTarget.setSize(size, size);
      this.heightTarget.texture.needsUpdate = true;
    }
    this.flushCaches();
  }

  target(ch: PbrSocket): RenderTarget {
    let rt = this.targets.get(ch);
    if (!rt) {
      rt = makeChannelTarget(ch, this.size);
      this.targets.set(ch, rt);
    }
    return rt;
  }

  // The persistent bake material for a channel (created on first use). `bakeInto` sets its colorNode;
  // `rerenderInto` reuses it as-is.
  channelMaterial(ch: PbrSocket | "height"): MeshBasicNodeMaterial {
    let m = this.mats.get(ch);
    if (!m) {
      m = makeChannelMaterial();
      this.mats.set(ch, m);
    }
    return m;
  }

  // Intermediate cache target/material/texture for a decomposed group output (created on first use). The
  // texture is handed to the compiler (as the downstream sample source); the material renders the group's
  // value into it.
  // `size` = this cache's absolute px size (the bake size, or the derivative path's reference-res floor, see
  // cacheSizeFor), or the set's global size. `mips` (derivative path) adds trilinear mips for faithful
  // downsampling. Resized in place when it changes across a structural rebuild, so the same texture object is
  // reused downstream.
  cacheTarget(cacheId: string, size: number = this.size, mips = false): RenderTarget {
    let rt = this.cacheTargets.get(cacheId);
    // Recreate if the mip requirement changed (a stable cacheId keeps the same sizing in practice, so this is
    // just a safety net); resize in place otherwise so the same texture object stays wired downstream.
    if (rt && rt.texture.generateMipmaps !== mips) {
      rt.dispose();
      this.cacheTargets.delete(cacheId);
      rt = undefined;
    }
    if (!rt) {
      rt = makeCacheTarget(size, mips);
      this.cacheTargets.set(cacheId, rt);
    } else if (rt.width !== size || rt.height !== size) {
      rt.setSize(size, size);
    }
    return rt;
  }
  cacheMaterial(cacheId: string): MeshBasicNodeMaterial {
    let m = this.cacheMats.get(cacheId);
    if (!m) {
      m = makeChannelMaterial();
      this.cacheMats.set(cacheId, m);
    }
    return m;
  }
  cacheTexture(cacheId: string, size?: number, mips = false): THREE.Texture {
    return this.cacheTarget(cacheId, size, mips).texture;
  }

  // Drop every decomposition cache the current compile no longer references. Cache ids embed node ids
  // (`groupId/portKey`, `nodeId/field`), so deleting/recreating a group — or loading a different document
  // into this set — orphans the old entries; without pruning each one pins an 11–43MB 16F render target
  // for the life of the surface (the unbounded GPU growth on group churn / document switches). Safe to
  // dispose between bakes: cache textures are only sampled by bake materials during a bake render, never
  // by the on-screen surface, and the serial queue guarantees the previous bake's GPU work has drained.
  pruneCaches(liveIds: ReadonlySet<string>): void {
    for (const [id, rt] of this.cacheTargets) {
      if (liveIds.has(id)) continue;
      rt.dispose();
      this.cacheTargets.delete(id);
    }
    for (const [id, m] of this.cacheMats) {
      if (liveIds.has(id)) continue;
      m.dispose();
      this.cacheMats.delete(id);
    }
  }

  // Any already-allocated render target, for a 1px GPU-completion readback (back-pressure). Null if nothing
  // has been baked yet.
  firstTarget(): RenderTarget | null {
    for (const rt of this.targets.values()) return rt;
    return this.heightTarget;
  }

  ensureHeightTarget(): RenderTarget {
    if (!this.heightTarget) this.heightTarget = makeChannelTarget("height", this.size);
    return this.heightTarget;
  }

  // The baked texture for a channel (null if never baked). Surfaces sample these.
  texture(ch: PbrSocket): THREE.Texture | null {
    return this.targets.get(ch)?.texture ?? null;
  }

  // Flush intermediate GPU caches and force a full channel recompile on the next bake, WITHOUT touching the
  // channel/height TARGET textures the live surface samples. Destroying a target the render loop still has
  // bound is a WebGPU error ("Destroyed texture used in a submit"), so "Regenerate" re-bakes into the same
  // targets in place instead of swapping the set. The bake materials here are internal to baking (never on
  // the mesh), so disposing them is safe and makes the next bake rebuild them from scratch.
  // ctx.constantArray backing store (injected into the compiler as opts.allocConstantArray). Returns a
  // retained uniformArray for (nodeId, key): if one of the same length exists, copy the new contents into its
  // `.array` in place (uploads on the next render — the same mechanism curve uniforms use) and hand back the
  // SAME node so three keeps it bound; otherwise (first use / length changed = a real structural change)
  // create a fresh one. Length changes flow through to a recompile via the normal build() path.
  allocConstantArray(
    nodeId: string,
    key: string,
    data: ArrayLike<number>,
    elementType: "float" | "vec3",
  ): MaterialValue {
    const id = `${nodeId}/${key}`;
    const existing = this.constArrays.get(id);
    // Same length + element type → mutate the SAME node's `.array` in place (uploads next render) and reuse it.
    // `.array` holds number primitives (float) or THREE.Vector3 objects (vec3); UniformArrayNode reads either.
    if (existing && existing.length === data.length && existing.elementType === elementType) {
      const arr = (existing.node as unknown as { array: unknown[] }).array;
      if (elementType === "vec3") {
        const vecs = arr as THREE.Vector3[];
        for (let i = 0; i < vecs.length; i++) vecs[i].set(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]);
      } else {
        const nums = arr as number[];
        for (let i = 0; i < data.length; i++) nums[i] = data[i];
      }
      return existing.node;
    }
    let node: MaterialValue;
    if (elementType === "vec3") {
      const vecs: THREE.Vector3[] = [];
      for (let i = 0; i < data.length; i += 3) vecs.push(new THREE.Vector3(data[i], data[i + 1], data[i + 2]));
      node = uniformArray(vecs) as MaterialValue;
    } else {
      node = uniformArray(Array.from(data), "float") as MaterialValue;
    }
    this.constArrays.set(id, { node, length: data.length, elementType });
    return node;
  }

  flushCaches(): void {
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
    for (const rt of this.cacheTargets.values()) rt.dispose();
    this.cacheTargets.clear();
    for (const m of this.cacheMats.values()) m.dispose();
    this.cacheMats.clear();
    this.cachePlan = [];
    this.uniforms = new Map();
    this.paramUsage = new Map();
    this.constArrays.clear();
  }

  dispose(): void {
    for (const rt of this.targets.values()) rt.dispose();
    this.targets.clear();
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
    for (const rt of this.cacheTargets.values()) rt.dispose();
    this.cacheTargets.clear();
    for (const m of this.cacheMats.values()) m.dispose();
    this.cacheMats.clear();
    this.cachePlan = [];
    this.uniforms = new Map();
    this.paramUsage = new Map();
    this.constArrays.clear();
    this.heightTarget?.dispose();
    this.heightTarget = null;
  }
}

export interface BakeProgress {
  completed: number;
  total: number;
  active: string | null;
}

export class MaterialBakeService {
  private renderer: WebGPURenderer | null = null;
  // Render gate. `renderer.compileAsync` (used to compile bake pipelines off the blocking path) mutates
  // SHARED renderer state and has a long await window; if the app's animate loop renders during that
  // window it does so in a corrupted state (black screen / broken geometry). While this depth is > 0 the
  // animate loop must skip its `renderer.render` — see app.ts. Held only during the async-compile window;
  // the synchronous bake renders that follow can't be interleaved (JS is single-threaded, no awaits).
  private compileGateDepth = 0;
  get rendererBusy(): boolean {
    return this.compileGateDepth > 0;
  }
  // Serial job chain — bakes run one at a time (shared GPU quads). Each job appends to this promise.
  private queue: Promise<unknown> = Promise.resolve();
  private completed = 0;
  private total = 0;
  private active: string | null = null;
  private readonly progressListeners = new Set<(p: BakeProgress) => void>();
  private readonly reportListeners = new Set<(r: BakeReport) => void>();
  private bakeRunId = 0; // stamped on each BakeReport so listeners can tell runs apart
  // Scratch readback target for readImage (one-off PNG/preview); resized on demand.
  private scratch: RenderTarget | null = null;
  private scratchSize = 0;
  // Transient decomposition caches for readImage (the 2D preview / PNG export path has no persistent set).
  // Reused across calls; recreated when the readback size changes.
  private readonly scratchCaches = new Map<string, { rt: RenderTarget; mat: MeshBasicNodeMaterial }>();
  private scratchCacheSize = 0;

  // Wired once after renderer.init() (replaces the old per-controller attachRenderer). Surfaces that tried
  // to bake before this fall back to the live procedural material until a renderer exists.
  attachRenderer(renderer: WebGPURenderer): void {
    this.renderer = renderer;
  }
  get hasRenderer(): boolean {
    return this.renderer !== null;
  }

  onProgress(cb: (p: BakeProgress) => void): () => void {
    this.progressListeners.add(cb);
    return () => this.progressListeners.delete(cb);
  }
  private emitProgress(): void {
    const p: BakeProgress = { completed: this.completed, total: this.total, active: this.active };
    for (const cb of this.progressListeners) cb(p);
  }

  // Per-run telemetry for the editor's progress widget (distinct from the job-level onProgress above).
  onBakeReport(cb: (r: BakeReport) => void): () => void {
    this.reportListeners.add(cb);
    return () => this.reportListeners.delete(cb);
  }
  private emitReport(r: BakeReport): void {
    for (const cb of this.reportListeners) cb(r);
  }

  // Append one unit of GPU work to the serial queue. `total` grows as jobs enqueue and both counters reset
  // when the queue fully drains, so progress reads as N-of-M across a burst then clears.
  private enqueue<T>(label: string, job: () => T | Promise<T>): Promise<T> {
    this.total += 1;
    this.emitProgress();
    const run = this.queue.then(async () => {
      this.active = label;
      this.emitProgress();
      try {
        return await job();
      } finally {
        this.completed += 1;
        this.active = null;
        console.log(`[bake] ${this.completed}/${this.total} ${label}`);
        if (this.completed >= this.total) {
          this.completed = 0;
          this.total = 0;
        }
        this.emitProgress();
      }
    });
    // Keep the chain alive even if a job throws (one bad bake mustn't stall every later one).
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  createTextureSet(channels: PbrSocket[] = SURFACE_CHANNELS, size: number = BAKE_SIZE): BakedTextureSet {
    return new BakedTextureSet(size, channels);
  }

  // Render a graph's connected channels into `set`, in place (queued). Resolves true when the present
  // channel set changed since the last bake (so the caller rewires its samplers), false to just re-render.
  bakeInto(set: BakedTextureSet, graph: MaterialGraphSource, opts: BakeOptions = {}): Promise<boolean> {
    return this.enqueue(opts.label ?? "surface", async () => {
      const renderer = this.renderer;
      if (!renderer) return false;
      const tCompile0 = performance.now();
      // Decompose: each group's outputs are baked to their own intermediate textures (allocCache hands the
      // compiler the cache texture to sample downstream) so no channel shader inlines the whole graph.
      const { bundle, uniforms, cachePlan, paramUsage } = graph.compileBundle({
        backend: "offline",
        soloNodeId: opts.soloNodeId,
        allocCache: (cacheId, _kind, sizing) =>
          set.cacheTexture(cacheId, cacheSizeFor(set.size, sizing), cacheWantsMips(sizing)),
        allocConstantArray: (nodeId, key, data, elementType) =>
          set.allocConstantArray(nodeId, key, data, elementType),
      });
      const compileMs = performance.now() - tCompile0;
      const nodeCount = countGraphNodes(graph.document);
      set.uniforms = uniforms; // retained so a uniform-only edit can re-render without recompiling
      set.paramUsage = paramUsage; // retained so the surface routes edits (live vs rebuild) off real usage
      set.cachePlan = cachePlan; // retained so a uniform re-render regenerates caches in the same order
      // Prune caches orphaned by this compile (deleted/recreated groups, document switches). Skipped under
      // solo: a solo compile intentionally omits the group caches, and dropping them would force a full
      // (multi-hundred-MB) cache re-render on every solo toggle.
      if (!opts.soloNodeId) set.pruneCaches(new Set(cachePlan.map((e) => e.cacheId)));
      const channels = opts.channels ?? set.channels;
      const present = new Set<PbrSocket>();
      // Collect channel jobs first (assigning colorNode + needsUpdate is what marks them for recompile).
      type Job = { mat: MeshBasicNodeMaterial; target: RenderTarget; isNormal: boolean };
      const jobs: Job[] = [];
      for (const ch of channels) {
        const node = (bundle as Partial<Record<string, MaterialValue>>)[ch];
        if (!node) continue;
        const mat = set.channelMaterial(ch);
        mat.colorNode = encodeChannel(node, ch);
        mat.needsUpdate = true;
        jobs.push({ mat, target: set.target(ch), isNormal: ch === "normal" });
        present.add(ch);
      }
      // Height drives the parallax UV offset (its own linear target), not a lit channel.
      set.hasHeight = bundle.height !== undefined;
      if (set.hasHeight) {
        const hm = set.channelMaterial("height");
        hm.colorNode = vec3(bundle.height);
        hm.needsUpdate = true;
        jobs.push({ mat: hm, target: set.ensureHeightTarget(), isNormal: false });
      }
      // Telemetry base for this run; phase/totalMs are filled as we go.
      const report: BakeReport = {
        runId: ++this.bakeRunId,
        source: opts.source,
        phase: "nodes",
        nodeCount,
        compileMs,
        texturesTotal: jobs.length,
        totalMs: 0,
      };
      this.emitReport(report); // graph compiled, N textures to regenerate
      // Render the decomposition caches (bottom-up) BEFORE the channels sample them. Each is a small
      // single-group shader, compiled synchronously here (fast) — the whole point is that no channel inlines
      // the graph. Synchronous, so no render-gate needed (nothing can interleave).
      for (const entry of cachePlan) {
        const cm = set.cacheMaterial(entry.cacheId);
        cm.colorNode = entry.colorNode;
        cm.needsUpdate = true;
        renderCacheToTarget(
          renderer,
          cm,
          set.cacheTarget(entry.cacheId, cacheSizeFor(set.size, entry.sizing), cacheWantsMips(entry.sizing)),
        );
      }
      let precompileMs = 0;
      if (ASYNC_PIPELINE_COMPILE) {
        // Chromium/Dawn: compile the (changed) channel pipelines asynchronously and IN PARALLEL (one
        // compileAsync over all channel materials) — non-blocking, so the heavy shader compile doesn't
        // freeze the editor, and wall time is ~max(channel) not the serial sum. The gate pauses the app's
        // animate render for this window only (compileAsync's await is the one place a concurrent render
        // would corrupt shared renderer state); the synchronous renders below can't interleave.
        this.emitReport({ ...report, phase: "shaders" }); // pipelines compiling (the dominant phase)
        const tPrecompile0 = performance.now();
        this.compileGateDepth += 1;
        try {
          await compileMaterialsAsync(
            renderer,
            jobs.map((j) => j.mat),
            set.size,
          );
        } finally {
          this.compileGateDepth -= 1;
        }
        precompileMs = performance.now() - tPrecompile0;
      }
      // The renders: warm pipelines (Chromium async pre-warm) draw in ~ms; elsewhere each pipeline compiles
      // SYNCHRONOUSLY here on first draw (no off-thread option on those browsers — a single compile, never a
      // gate or a double-compile).
      const tDispatch0 = performance.now();
      for (const j of jobs) renderMaterialToTarget(renderer, j.mat, j.target, j.isNormal);
      const dispatchMs = performance.now() - tDispatch0;
      const signature = [...present].sort().join(",") + (set.hasHeight ? "|h" : "");
      const changed = signature !== set.signature;
      set.present = present;
      set.signature = signature;
      // Wait for the GPU to actually finish before resolving — gives the caller real back-pressure so it
      // can't submit the next bake while this one is still executing (the cause of the editing GPU backlog).
      const tGpu0 = performance.now();
      await this.gpuSync(set);
      const gpuWaitMs = performance.now() - tGpu0;
      // Real generation time the widget reports = compile + shader-compile + render + GPU completion.
      const totalMs = compileMs + precompileMs + dispatchMs + gpuWaitMs;
      this.emitReport({ ...report, phase: "done", totalMs });
      if (BAKE_PROFILE) {
        // precompile = async (non-blocking, render-gated) pipeline compile via compileAsync; dispatch =
        // warm render calls; gpuWait = wall time to GPU completion. The heavy time sits in the gated
        // precompile phase, during which the 3D canvas holds its last frame instead of freezing.
        console.log(
          `[bake-prof] rebuild compile=${compileMs.toFixed(1)} precompile=${precompileMs.toFixed(1)} ` +
            `dispatch=${dispatchMs.toFixed(1)} gpuWait=${gpuWaitMs.toFixed(1)} total=${totalMs.toFixed(1)}ms`,
        );
      }
      return changed;
    });
  }

  // Resolve only once the GPU has finished the preceding renders — turning "submitted" into "completed" so
  // the caller has real back-pressure. Prefer the WebGPU queue's transfer-free `onSubmittedWorkDone`; fall
  // back to a 1px readback (also forces a GPU sync) when the backend doesn't expose it.
  private async gpuSync(set: BakedTextureSet): Promise<void> {
    const renderer = this.renderer;
    if (!renderer) return;
    const queue = (renderer as unknown as { backend?: { device?: { queue?: GPUQueueLike } } }).backend
      ?.device?.queue;
    if (queue?.onSubmittedWorkDone) {
      await queue.onSubmittedWorkDone();
      return;
    }
    const rt = set.firstTarget();
    if (rt) await renderer.readRenderTargetPixelsAsync(rt, 0, 0, 1, 1);
  }

  // Re-render the LAST-compiled per-channel materials into `set`'s targets WITHOUT recompiling. The caller
  // has updated uniform values in place (set.uniforms), so the existing pipelines just draw with new values
  // — the fast path for slider drags. Serialised after any in-flight bake (shared GPU quads); no progress
  // counter (this isn't a "bake" the UI should report).
  rerenderInto(set: BakedTextureSet, source?: string): Promise<void> {
    const run = this.queue.then(async () => {
      const renderer = this.renderer;
      if (!renderer) return;
      const total = set.present.size + (set.hasHeight && set.heightTarget ? 1 : 0);
      // Uniform re-render: no recompile (nodeCount 0), only the channel renders are regenerated.
      const report: BakeReport = {
        runId: ++this.bakeRunId,
        source,
        phase: "render",
        nodeCount: 0,
        compileMs: 0,
        texturesTotal: total,
        totalMs: 0,
      };
      this.emitReport(report); // run started
      const tDispatch0 = performance.now();
      // Regenerate the decomposition caches first (bottom-up), reusing their pipelines: a uniform edit inside
      // a group changed a uniform the cache material references, so the cache — and thus every channel that
      // samples it — must be re-rendered. No recompile (colorNode unchanged), just new uniform values.
      for (const entry of set.cachePlan) {
        renderCacheToTarget(
          renderer,
          set.cacheMaterial(entry.cacheId),
          set.cacheTarget(entry.cacheId, cacheSizeFor(set.size, entry.sizing), cacheWantsMips(entry.sizing)),
        );
      }
      for (const ch of set.present) {
        renderMaterialToTarget(renderer, set.channelMaterial(ch), set.target(ch), ch === "normal");
      }
      if (set.hasHeight && set.heightTarget) {
        renderMaterialToTarget(renderer, set.channelMaterial("height"), set.heightTarget, false);
      }
      const dispatchMs = performance.now() - tDispatch0;
      // Baseline path (no recompile): same channels re-rendered, reusing existing pipelines.
      const tGpu0 = performance.now();
      await this.gpuSync(set); // back-pressure: resolve only after the GPU finishes (see bakeInto)
      const gpuWaitMs = performance.now() - tGpu0;
      this.emitReport({ ...report, phase: "done", totalMs: dispatchMs + gpuWaitMs });
      if (BAKE_PROFILE) {
        console.log(
          `[bake-prof] rerender dispatch=${dispatchMs.toFixed(1)} gpuWait=${gpuWaitMs.toFixed(1)}ms`,
        );
      }
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // Convenience pipeline: instantiate a texture set, bake the graph into it, hand it back (caller disposes).
  // This is the "set a preset, await the textures" path for callers that don't keep a live surface.
  async bake(graph: MaterialGraphSource, opts: BakeOptions = {}): Promise<BakedTextureSet> {
    const set = this.createTextureSet(opts.channels, opts.size);
    await this.bakeInto(set, graph, opts);
    return set;
  }

  // Bake one channel and read it back as top-down ImageData (null if unconnected). For PNG export / 2D
  // preview — takes a graph, never a live on-screen controller, so it can't clobber another object.
  readImage(graph: MaterialGraphSource, channel: PbrSocket, size = 512): Promise<ImageData | null> {
    return this.enqueue(`read:${channel}`, async () => {
      const renderer = this.renderer;
      if (!renderer) return null;
      // Decompose here too (same reason as the surface bake): without it, a complex graph inlines the whole
      // thing into this preview shader — which overflows Safari's 8192-byte limit and freezes Firefox's
      // synchronous compiler. Bake group outputs to transient caches, then the channel samples them.
      const { bundle, cachePlan } = graph.compileBundle({
        backend: "offline",
        allocCache: (cacheId, _kind, sizing) =>
          this.scratchCache(cacheId, size, cacheSizeFor(size, sizing), cacheWantsMips(sizing)).rt.texture,
      });
      const node = (bundle as Partial<Record<string, MaterialValue>>)[channel];
      if (!node) return null;
      // Same orphan problem as the surface set: scratch caches are keyed by node-id-derived cacheIds, so
      // group churn / document switches would pin stale 16F targets until the readback size changes.
      const liveIds = new Set(cachePlan.map((entry) => entry.cacheId));
      for (const [id, c] of this.scratchCaches) {
        if (liveIds.has(id)) continue;
        c.rt.dispose();
        c.mat.dispose();
        this.scratchCaches.delete(id);
      }
      for (const entry of cachePlan) {
        const c = this.scratchCache(entry.cacheId, size, cacheSizeFor(size, entry.sizing), cacheWantsMips(entry.sizing));
        c.mat.colorNode = entry.colorNode;
        c.mat.needsUpdate = true;
        renderCacheToTarget(renderer, c.mat, c.rt);
      }
      const rt = this.scratchTarget(size);
      renderColorNodeToTarget(renderer, encodeChannel(node, channel), rt, channel === "normal");
      // WebGPU readback is bottom-up RGBA8; flip vertically into the ImageData buffer. NOTE: `size` must
      // give 256-byte-aligned rows (multiple of 64 px) or the GPU copy's row padding scrambles the image.
      const buffer = (await renderer.readRenderTargetPixelsAsync(rt, 0, 0, size, size)) as unknown as Uint8Array;
      const data = new Uint8ClampedArray(size * size * 4);
      const stride = size * 4;
      for (let y = 0; y < size; y++) {
        const src = (size - 1 - y) * stride;
        data.set(buffer.subarray(src, src + stride), y * stride);
      }
      return new ImageData(data, size, size);
    });
  }

  private scratchTarget(size: number): RenderTarget {
    if (!this.scratch || this.scratchSize !== size) {
      this.scratch?.dispose();
      this.scratch = new RenderTarget(size, size, { depthBuffer: false, stencilBuffer: false });
      this.scratchSize = size;
    }
    return this.scratch;
  }

  // A transient decomposition cache (16F target + bake material) for readImage, keyed by cacheId. The whole
  // pool is dropped when the readback (channel) size `poolSize` changes; each cache is then allocated at its
  // OWN `cacheSize` (a group's bake-resolution override, or `poolSize` by default) — a finer cache is sampled
  // down by the channel's linear filter, so nfh inside a bumped group gets a clean derivative.
  private scratchCache(
    cacheId: string,
    poolSize: number,
    cacheSize: number,
    mips = false,
  ): { rt: RenderTarget; mat: MeshBasicNodeMaterial } {
    if (this.scratchCacheSize !== poolSize) {
      for (const c of this.scratchCaches.values()) {
        c.rt.dispose();
        c.mat.dispose();
      }
      this.scratchCaches.clear();
      this.scratchCacheSize = poolSize;
    }
    let c = this.scratchCaches.get(cacheId);
    if (c && c.rt.texture.generateMipmaps !== mips) {
      c.rt.dispose();
      c.mat.dispose();
      this.scratchCaches.delete(cacheId);
      c = undefined;
    }
    if (!c) {
      c = { rt: makeCacheTarget(cacheSize, mips), mat: makeChannelMaterial() };
      this.scratchCaches.set(cacheId, c);
    } else if (c.rt.width !== cacheSize || c.rt.height !== cacheSize) {
      c.rt.setSize(cacheSize, cacheSize);
    }
    return c;
  }
}

// The one shared instance every caller bakes through.
export const bakeService = new MaterialBakeService();
