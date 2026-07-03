import * as THREE from "three";
import type { MeshStandardNodeMaterial } from "three/webgpu";
import { uniform, vec3, normalWorld, texture, normalMap, float, attribute, uv } from "three/tsl";
import { compileGraph, newSurfaceMaterial, readOutputResolution } from "./compiler";
import { triplanarColor } from "../tsl/triplanar";
import { triplanarNormalMap } from "../tsl/triplanar-normal";
import { parallaxOcclusionUV } from "../tsl/parallax";
import {
  curveToArray,
  type CurveValue,
  type GraphChange,
  type MaterialBackend,
  type MaterialGraphSource,
  type MaterialValue,
  type PbrSocket,
} from "./types";
import { SURFACE_CHANNELS, type MaterialBakeService, type BakedTextureSet } from "./bake-service";

// Parallax-occlusion march steps (LINEAR cost, paid per preview fragment — the dominant GPU cost of the
// effect). 12 is the perf/quality balance.
const PARALLAX_LAYERS = 12;
// The on-screen surface bakes at the graph's authored `outputResolution` (Material Output), so the viewport is
// an exact preview of what an export at that resolution produces — lowering it makes editing cheaper AND the
// intermediate caches smaller, raising it (2048/4096) makes each re-bake heavier. See surfaceBakeSize().

// A live, on-screen material driven by a MaterialGraphSource. In the OFFLINE backend (default) it bakes
// the graph to per-channel textures THROUGH the shared MaterialBakeService and samples them (triplanar /
// POM) on a stock-PBR surface; in the LIVE backend it shows the procedural node material directly. It owns
// no GPU bake of its own — all baking funnels through the one service — and it never touches another
// object's document, so editing one surface can't knock out another. Subscribes to the graph's onChange and
// reacts: live-uniform tweak (live backend) / debounced re-bake (offline) / full rebuild (structural).
export class TexturedSurface {
  // The baked offline surface material (stock PBR sampling the baked maps). Stable object; re-bakes render
  // into its textures in place.
  private readonly offlineMat = newSurfaceMaterial();
  // Per-node uniforms from the last live compile (for the live-backend live-tweak fast path).
  private liveUniforms = new Map<string, Record<string, MaterialValue>>();
  // The currently-presented material (offline or live), re-read by listeners on rebuild.
  private material_: MeshStandardNodeMaterial;

  readonly scaleUniform = uniform(1.2); // triplanar world scale (the "world / tile" control)
  readonly sharpnessUniform = uniform(8); // triplanar blend exponent
  readonly roughnessFactor = uniform(1); // glTF-style factors multiplied into the baked channels (live)
  readonly metalnessFactor = uniform(1);
  readonly colorTint = uniform(new THREE.Color(1, 1, 1));
  readonly parallaxScale = uniform(0); // 0 = OFF (the march is opt-in; it's the effect's dominant cost)
  lastBakeMs = 0;

  private set: BakedTextureSet;
  private backend: MaterialBackend = "offline";
  private debugNormals = false;
  private triplanar = false; // off by default — plain mesh-UV sampling until enabled
  private wiredOnce = false;
  private lastPresent = new Set<PbrSocket>();
  // Single-flight coalescing for offline edits: at most one bake/re-render runs at a time (each awaits GPU
  // completion), and edits arriving while it runs collapse into ONE trailing update with the latest values.
  // This is what stops the editing GPU backlog — submissions can never outrun the GPU.
  private updateInFlight = false;
  private pendingKind: "none" | "rerender" | "rebuild" = "none";
  // "Regenerate": on the next rebuild, throw away the whole baked texture set (channel + decomposition-cache
  // targets/materials) and bake a fresh one — a from-scratch flush of all cached GPU state for this material.
  private flushRequested = false;
  private readonly listeners = new Set<() => void>();
  private lastError_: string | null = null;
  // Processing lifecycle: `busy` is true while a bake / re-render is in flight — including the in-place
  // texture resize at the start of a rebuild. Consumers gate their render loop on it, since rendering
  // during a rebuild submits a texture being resized/recreated ("Destroyed texture used in a submit").
  private processingDepth = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly graph: MaterialGraphSource,
    private readonly service: MaterialBakeService,
    // Identifies this surface in bake telemetry so UI can scope its progress.
    private readonly source?: string,
  ) {
    this.set = service.createTextureSet(SURFACE_CHANNELS, this.surfaceBakeSize());
    // Startup fallback: no renderer yet → procedural live material so the surface is valid; the first
    // refresh() (after the service gets a renderer) switches to the baked offline surface.
    this.material_ = this.buildLive();
    this.graph.onChange((change) => this.onGraphChange(change));
  }

  // The material to put on the mesh. Re-read by onRebuilt listeners whenever it changes (backend switch /
  // live recompile). Offline re-bakes keep the same object (textures update in place).
  get material(): MeshStandardNodeMaterial {
    return this.material_;
  }

  get lastError(): string | null {
    return this.lastError_;
  }

  // True while a bake / re-render is in flight (see the processing lifecycle above). Consumers should
  // skip rendering while busy to avoid submitting a texture that's being resized/recreated.
  get busy(): boolean {
    return this.processingDepth > 0;
  }

  // Resolves once no bake / re-render is in flight (immediately when already idle).
  whenIdle(): Promise<void> {
    if (this.processingDepth === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private enterProcessing(): void {
    this.processingDepth += 1;
  }
  private exitProcessing(): void {
    this.processingDepth -= 1;
    if (this.processingDepth === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  // ms of the last offline texture re-bake (0 in the live backend, which has no bake step).
  getLastBakeMs(): number {
    return this.backend === "offline" ? this.lastBakeMs : 0;
  }

  // Subscribe to material rebuilds (a new material object, or a backend switch). Returns an unsubscribe fn.
  onRebuilt(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  // Re-derive the material from the current graph + backend (awaitable). Call after the service gains a
  // renderer, or on a backend switch — and internally on structural graph changes. Resolves once the bake
  // (or live recompile) and any rewire have completed, so callers can use `.material` immediately after.
  refresh(): Promise<void> {
    return this.rebuild();
  }

  // Regenerate from scratch: flush ALL baked GPU state (every channel + decomposition-cache target and its
  // material) and re-bake with a full recompile. Routed through the single-flight pump so it can't race a bake
  // that's already running. Use when caches may be stale/corrupt; heavier than a normal re-bake.
  regenerate(): void {
    this.flushRequested = true;
    this.requestUpdate("rebuild");
  }

  // --- live surface tuning (offline backend) -----------------------------------------------------
  setScale(value: number): void {
    this.scaleUniform.value = value;
  }
  setSharpness(value: number): void {
    this.sharpnessUniform.value = value;
  }
  setRoughnessFactor(value: number): void {
    this.roughnessFactor.value = value;
  }
  setMetalnessFactor(value: number): void {
    this.metalnessFactor.value = value;
  }
  setColorTint(hex: string): void {
    this.colorTint.value.set(hex);
  }
  // Parallax depth. 0 must REMOVE the march (its dominant cost), so crossing 0 re-wires; above 0 it's live.
  setParallaxScale(value: number): void {
    const wasOn = this.parallaxScale.value > 0;
    this.parallaxScale.value = value;
    if (value > 0 !== wasOn) this.wire(this.lastPresent);
  }
  setTriplanar(on: boolean): void {
    if (on === this.triplanar) return;
    this.triplanar = on;
    this.wire(this.lastPresent);
  }
  setNormalDebug(on: boolean): void {
    if (on === this.debugNormals) return;
    this.debugNormals = on;
    this.wire(this.lastPresent);
  }
  setBackend(backend: MaterialBackend): void {
    if (backend === this.backend) return;
    this.backend = backend;
    void this.rebuild();
  }
  getBackend(): MaterialBackend {
    return this.backend;
  }

  // --- reacting to graph edits -------------------------------------------------------------------
  private onGraphChange(change: GraphChange): void {
    if (change.kind === "layout") {
      return;
    }

    if (change.kind === "param") {
      // Live backend: float/colour/vec3/curve params are live uniforms — update in place, no re-bake.
      if (this.backend === "live") {
        if (this.updateLiveUniform(change)) return;
        this.requestUpdate("rebuild");
        return;
      }
      // Offline FAST PATH: the param is a live uniform that the last bake's channel materials reference, so
      // update its value in place and just RE-RENDER the channels (no compileBundle, no WGSL recompile). Only
      // structural params (int/select/bool — no matching uniform) fall through to a full re-bake.
      if (this.updateOfflineUniform(change)) {
        this.requestUpdate("rerender");
        return;
      }
      this.requestUpdate("rebuild");
      return;
    }
    // Structural (topology / load / solo / int-bool-select / group): needs a full recompile.
    this.requestUpdate("rebuild");
  }

  // Apply a param's value to its uniform node in place (no recompile). Shared by the live and offline paths.
  private applyUniformValue(u: MaterialValue, change: Extract<GraphChange, { kind: "param" }>): void {
    if (change.paramType === "color") {
      u.value = new THREE.Color(change.value as THREE.ColorRepresentation);
    } else if (change.paramType === "vec3") {
      const v = change.value as { x: number; y: number; z: number };
      u.value.set(v.x, v.y, v.z);
    } else if (change.paramType === "curve") {
      const flat = curveToArray(change.value as CurveValue);
      const arr = (u as unknown as { array: number[] }).array;
      for (let i = 0; i < flat.length; i++) arr[i] = flat[i];
    } else {
      u.value = Number(change.value);
    }
  }

  // Live backend: update the compiled live material's uniform. Returns false if no matching uniform exists.
  private updateLiveUniform(change: Extract<GraphChange, { kind: "param" }>): boolean {
    const u = this.liveUniforms.get(change.nodeId)?.[change.key];
    if (!u) return false;
    this.applyUniformValue(u, change);
    return true;
  }

  // Offline backend: update the retained uniform that the last bake's channel materials reference. Returns
  // false if there's no matching uniform (structural param, or no bake has happened yet) → caller re-bakes.
  private updateOfflineUniform(change: Extract<GraphChange, { kind: "param" }>): boolean {
    // Build-time-in-offline floats (e.g. Voronoi scale/randomness, noise aspect) aren't live uniforms in the
    // bake — updating one wouldn't change the output, so force a re-bake instead of a (no-op) re-render.
    if (change.bakeStructural) return false;
    const u = this.set.uniforms.get(change.nodeId)?.[change.key];
    if (!u) return false;
    this.applyUniformValue(u, change);
    return true;
  }

  // Request an offline update, coalescing into the single-flight loop. "rebuild" (recompile) supersedes a
  // pending "rerender" (a rebuild is a superset); a rerender never downgrades a pending rebuild.
  private requestUpdate(kind: "rerender" | "rebuild"): void {
    if (kind === "rebuild" || this.pendingKind === "none") this.pendingKind = kind;
    void this.pump();
  }

  // Single-flight pump: run at most one bake/re-render at a time. Each awaits GPU completion (via the bake
  // service's gpuSync), so the next iteration can't start until the GPU has drained — no submission backlog.
  // Edits during a run set `pendingKind`; the loop then runs ONCE more with the latest graph/uniform values.
  private async pump(): Promise<void> {
    if (this.updateInFlight) return;
    this.updateInFlight = true;
    try {
      while (this.pendingKind !== "none") {
        const kind = this.pendingKind;
        this.pendingKind = "none";
        if (kind === "rebuild") await this.rebuild();
        else await this.rerenderOffline();
      }
    } finally {
      this.updateInFlight = false;
    }
  }

  // Re-render the offline channel textures from the retained materials (uniforms already updated). No
  // recompile. The 3D surface samples the same texture objects, so it updates on the next animation frame —
  // no `notify()` needed (and skipping it avoids kicking off a preview re-bake on every drag tick).
  private async rerenderOffline(): Promise<void> {
    if (this.backend !== "offline" || !this.service.hasRenderer) return;
    this.enterProcessing();
    try {
      await this.service.rerenderInto(this.set, this.source);
      this.lastError_ = this.graph.lastError;
    } catch (err) {
      this.lastError_ = err instanceof Error ? err.message : String(err);
      console.warn("[textured-surface] re-render failed:", this.lastError_);
    } finally {
      this.exitProcessing();
    }
  }

  // The on-screen bake resolution = the graph's authored output resolution (Material Output). Rounded to a
  // multiple of 64 so the service's readback alignment holds even for odd authored values.
  private surfaceBakeSize(): number {
    return Math.max(64, Math.round(readOutputResolution(this.graph.document) / 64) * 64);
  }

  // Re-derive the presented material. Offline (with a renderer): bake the graph into the texture set via the
  // service, rewire on a channel-set change. Otherwise: compile the procedural live material.
  private async rebuild(): Promise<void> {
    this.enterProcessing();
    try {
      try {
      if (this.backend === "offline" && this.service.hasRenderer) {
        // Re-bake into the SAME texture set — never swap it out. The live surface material keeps sampling
        // these exact THREE.Texture objects, so nothing it has bound is ever destroyed mid-render (which the
        // WebGPU backend rejects: "Destroyed texture used in a submit"). "Regenerate" flushes the caches +
        // bake materials in place; an output-resolution change resizes the targets in place. Both keep the
        // texture objects, so no rewire/rebind is needed either.
        const size = this.surfaceBakeSize();
        if (this.flushRequested) {
          this.flushRequested = false;
          this.set.flushCaches();
        }
        this.set.resize(size);
        const soloNodeId = this.graph.soloNode ?? undefined;
        const t0 = performance.now();
        const changed = await this.service.bakeInto(this.set, this.graph, {
          soloNodeId,
          label: "surface",
          source: this.source,
        });
        this.lastBakeMs = performance.now() - t0;
        if (changed || !this.wiredOnce) {
          this.wire(this.set.present);
          this.wiredOnce = true;
        }
        this.material_ = this.offlineMat;
      } else {
        this.material_ = this.buildLive();
      }
      this.lastError_ = this.graph.lastError;
      } catch (err) {
        this.lastError_ = err instanceof Error ? err.message : String(err);
        console.warn("[textured-surface] rebuild failed:", this.lastError_);
      }
      this.notify();
    } finally {
      this.exitProcessing();
    }
  }

  // Compile the procedural live material (used as a startup fallback and the "live" backend).
  private buildLive(): MeshStandardNodeMaterial {
    const soloNodeId = this.graph.soloNode ?? undefined;
    const { material, uniforms } = compileGraph(this.graph.document, this.graph.getRegistry(), {
      backend: "live",
      soloNodeId,
    });
    this.liveUniforms = uniforms;
    return material;
  }

  // Point the offline surface material's channel nodes at the baked textures. Only called when the present
  // channel set changes — re-baking re-renders the same texture objects in place.
  private wire(present: Set<PbrSocket>): void {
    this.lastPresent = present;
    const m = this.offlineMat;
    const scale = this.scaleUniform;
    const sharp = this.sharpnessUniform;
    const useParallax = this.set.hasHeight && !this.triplanar && this.parallaxScale.value > 0;
    const baseUv = uv();
    const pUv: MaterialValue = useParallax
      ? parallaxOcclusionUV(this.set.heightTarget!.texture, baseUv, this.parallaxScale, PARALLAX_LAYERS)
      : undefined;
    // Sample AT the parallax-offset location but take the mip LOD from the smooth base-UV derivatives.
    const ddx = baseUv.dFdx();
    const ddy = baseUv.dFdy();
    const sampleUv = (tex: MaterialValue): MaterialValue =>
      useParallax ? texture(tex, pUv).grad(ddx, ddy) : texture(tex);
    const sample = (ch: PbrSocket): MaterialValue =>
      this.triplanar
        ? triplanarColor(this.set.texture(ch)!, scale, sharp)
        : sampleUv(this.set.texture(ch)!);
    const shadingNormal: MaterialValue = !present.has("normal")
      ? normalWorld
      : this.triplanar
        ? triplanarNormalMap(this.set.texture("normal")!, scale, sharp)
        : normalMap(sampleUv(this.set.texture("normal")!).xyz, float(1));

    if (this.debugNormals) {
      m.colorNode = vec3(0, 0, 0);
      m.emissiveNode = shadingNormal.normalize().mul(0.5).add(0.5);
      m.roughnessNode = m.metalnessNode = m.aoNode = m.normalNode = null;
      m.needsUpdate = true;
      return;
    }
    m.colorNode = present.has("baseColor") ? sample("baseColor").mul(this.colorTint) : null;
    m.roughnessNode = present.has("roughness") ? sample("roughness").r.mul(this.roughnessFactor) : null;
    m.metalnessNode = present.has("metallic") ? sample("metallic").r.mul(this.metalnessFactor) : null;
    const vAo = attribute("vertexAo", "float");
    m.aoNode = present.has("ambientOcclusion") ? sample("ambientOcclusion").r.mul(vAo) : vAo;
    m.normalNode = present.has("normal") ? shadingNormal : null;
    m.emissiveNode = present.has("emission") ? sample("emission") : null;
    m.needsUpdate = true;
  }

  dispose(): void {
    this.set.dispose();
    this.offlineMat.dispose();
  }
}
