import * as THREE from "three";
import { OrthographicCamera, Scene } from "three";
import { float, uv, vec3 } from "three/tsl";
import {
  MeshBasicNodeMaterial,
  QuadMesh,
  RenderTarget,
  type WebGPURenderer,
} from "three/webgpu";
import type { MaterialBakeService } from "../graph/bake-service";
import { makeChannelMaterial, renderCacheToTarget } from "../graph/channel-baker";
import {
  deriveMeasuredNodeCosts,
  measureNodeShaderMetrics,
  median,
  profilableNodeOutputs,
  profileWorkload,
  type NodeProfileOptions,
  type NodeProfileReport,
  type NodeProfileRow,
} from "../graph/node-profiler";
import { createShaderCacheBuster } from "../graph/shader-cache-bust";
import type {
  CompileNodeInputsContext,
  CompileNodeOutputsContext,
} from "../graph/compiler";
import type { MaterialGraphSource, MaterialValue, PortDef, PortKind } from "../graph/types";

type GPUQueueLike = { onSubmittedWorkDone?: () => Promise<void> };
type TimestampBackendLike = {
  trackTimestamp?: boolean;
  getTimestampUID?: (renderContext: unknown) => string;
  getTimestamp?: (uid: string) => number;
  hasTimestamp?: (uid: string) => boolean;
};
type TimestampRendererLike = {
  _currentRenderContext?: unknown;
  _renderContexts?: { get: (target: RenderTarget, mrt?: unknown, callDepth?: number) => unknown };
  _mrt?: unknown;
  _callDepth?: number;
};

const compileScene = new Scene();
const compileCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
const compileQuad = new QuadMesh();

function createProfileRunId(): string {
  const values = new Uint32Array(2);
  if (typeof crypto !== "undefined") crypto.getRandomValues(values);
  else {
    values[0] = Date.now() >>> 0;
    values[1] = Math.floor(Math.random() * 0xffffffff) >>> 0;
  }
  return Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("");
}

function prepareSingleCompile(material: MeshBasicNodeMaterial): void {
  compileScene.clear();
  compileQuad.material = material;
  compileScene.add(compileQuad);
}

async function compileMaterialAsync(
  renderer: WebGPURenderer,
  material: MeshBasicNodeMaterial,
  target: RenderTarget,
): Promise<void> {
  prepareSingleCompile(material);
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  try {
    await renderer.compileAsync(compileScene, compileCamera);
  } finally {
    renderer.setRenderTarget(previous);
  }
}

async function inspectMaterialShaderAsync(
  renderer: WebGPURenderer,
  material: MeshBasicNodeMaterial,
  target: RenderTarget,
): Promise<{ fragmentShader: string; vertexShader: string }> {
  prepareSingleCompile(material);
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  try {
    const shader = await renderer.debug.getShaderAsync(compileScene, compileCamera, compileQuad);
    return {
      fragmentShader: shader.fragmentShader ?? "",
      vertexShader: shader.vertexShader ?? "",
    };
  } finally {
    renderer.setRenderTarget(previous);
  }
}

async function gpuSync(renderer: WebGPURenderer, fallback: RenderTarget): Promise<void> {
  const queue = (renderer as unknown as { backend?: { device?: { queue?: GPUQueueLike } } }).backend
    ?.device?.queue;
  if (queue?.onSubmittedWorkDone) {
    await queue.onSubmittedWorkDone();
    return;
  }
  await renderer.readRenderTargetPixelsAsync(fallback, 0, 0, 1, 1);
}

function isolatedInput(kind: PortKind, index: number): MaterialValue | undefined {
  if (kind === "shader") return undefined;
  const texcoord = uv();
  const a = texcoord.x.mul(0.31 + index * 0.07).add(texcoord.y.mul(0.17 + index * 0.05));
  if (kind === "float") return a;
  return vec3(
    a,
    texcoord.y.mul(0.43 + index * 0.03).add(texcoord.x.mul(0.11)),
    texcoord.x.mul(texcoord.y).add(index * 0.013),
  );
}

function isolateInputs(ctx: CompileNodeInputsContext, targetId: string) {
  if (ctx.node.id !== targetId) return ctx.inputs;
  const isolated = { ...ctx.inputs };
  let index = 0;
  for (const port of ctx.ports.inputs) {
    if (ctx.inputs[port.key] !== undefined) isolated[port.key] = isolatedInput(port.kind, index++);
  }
  return isolated;
}

function dependencyBaseline(
  ports: PortDef[],
  inputs: Record<string, MaterialValue | undefined>,
  outputKind: PortKind,
): MaterialValue {
  let value: MaterialValue = float(0.5);
  let connected = 0;
  for (const port of ports) {
    const input = inputs[port.key];
    if (input === undefined || port.kind === "shader") continue;
    const scalar = port.kind === "float" ? input : input.x;
    value = connected === 0 ? scalar : value.add(scalar.mul(0.001 * (connected + 1)));
    connected += 1;
  }
  return outputKind === "float" ? value : vec3(value);
}

function replaceWithBaseline(
  ctx: CompileNodeOutputsContext,
  targetId: string,
  output: PortDef,
): Record<string, MaterialValue> {
  if (ctx.node.id !== targetId) return ctx.outputs;
  return {
    ...ctx.outputs,
    [output.key]: dependencyBaseline(ctx.ports.inputs, ctx.inputs, output.kind),
  };
}

// Opt-in per-output profiler. This module is reachable only from the package's `/profiling` entry; the
// default runtime entry has no import path to timestamp queries, shader inspection, or workload accounting.
export function profileMaterialNodes(
  service: MaterialBakeService,
  graph: MaterialGraphSource,
  opts: NodeProfileOptions = {},
): Promise<NodeProfileReport> {
  const size = Math.max(64, Math.min(2048, opts.size ?? 512));
  const runs = Math.max(1, Math.min(32, opts.runs ?? 6));
  const compileRuns = Math.max(1, Math.min(5, opts.compileRuns ?? 3));

  return service.runRendererTask("profile", async (renderer) => {
    const profileRunId = createProfileRunId();
    const timestampBackend = renderer?.backend as unknown as TimestampBackendLike | undefined;
    let timestampQuerySupported = false;
    let timestampTrackingEnabled = false;
    const previousTimestampTracking = timestampBackend?.trackTimestamp === true;
    if (renderer) {
      try {
        timestampQuerySupported = renderer.hasFeature("timestamp-query");
      } catch {
        timestampQuerySupported = false;
      }
      if (timestampQuerySupported && timestampBackend) {
        timestampTrackingEnabled = true;
        timestampBackend.trackTimestamp = true;
      }
    }

    const report: NodeProfileReport = {
      size,
      runs,
      compileRuns,
      profileRunId,
      measurementMode: "isolated-node-minus-matched-baseline",
      timingMode: timestampTrackingEnabled ? "timestamp-query" : "wall-clock-fallback",
      timestampScope:
        timestampTrackingEnabled &&
        typeof timestampBackend?.getTimestampUID === "function" &&
        typeof timestampBackend?.getTimestamp === "function"
          ? "render-context"
          : timestampTrackingEnabled
            ? "aggregate-frame"
            : "unavailable",
      timestampQuerySupported,
      timestampTrackingEnabled,
      overheadMs: 0,
      compileOverheadMs: 0,
      nodes: [],
    };

    if (!renderer) return report;
    const target = new RenderTarget(size, size, { depthBuffer: false, stencilBuffer: false });

    try {
      if (timestampTrackingEnabled) {
        await renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);
      }

      const gpuSample = async (material: MeshBasicNodeMaterial): Promise<number> => {
        if (timestampTrackingEnabled) {
          renderCacheToTarget(renderer, material, target);
          const internalRenderer = renderer as unknown as TimestampRendererLike;
          const renderContext =
            internalRenderer._currentRenderContext ??
            internalRenderer._renderContexts?.get(
              target,
              internalRenderer._mrt,
              (internalRenderer._callDepth ?? -1) + 1,
            );
          const timestampUid =
            renderContext != null ? timestampBackend?.getTimestampUID?.(renderContext) : undefined;
          const duration = await renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);
          if (
            timestampUid &&
            timestampBackend?.hasTimestamp?.(timestampUid) !== false &&
            typeof timestampBackend?.getTimestamp === "function"
          ) {
            const contextDuration = timestampBackend.getTimestamp(timestampUid);
            if (Number.isFinite(contextDuration)) return contextDuration;
          }
          const infoDuration = renderer.info.render.timestamp;
          if (typeof infoDuration === "number" && Number.isFinite(infoDuration)) return infoDuration;
          return typeof duration === "number" && Number.isFinite(duration) ? duration : 0;
        }
        const startedAt = performance.now();
        renderCacheToTarget(renderer, material, target);
        await gpuSync(renderer, target);
        return performance.now() - startedAt;
      };

      type PreparedProfileMaterial = {
        material: MeshBasicNodeMaterial;
        pipelineCompileMs: number;
        vertexShader: string;
        fragmentShader: string;
      };

      const logCompiledVariant = (
        label: string,
        prepared: PreparedProfileMaterial,
        gpuMs: number,
      ): void => {
        console.groupCollapsed(label);
        console.log("Material", prepared.material);
        console.log("Measurements", {
          pipelineCompileMs: prepared.pipelineCompileMs,
          gpuMs,
        });
        console.log("Vertex WGSL", prepared.vertexShader);
        console.log("Fragment WGSL", prepared.fragmentShader);
        console.groupEnd();
      };

      const prepare = async (
        colorNode: MaterialValue,
        identity: string,
      ): Promise<PreparedProfileMaterial> => {
        const compileSamples: number[] = [];
        let measuredMaterial: MeshBasicNodeMaterial | null = null;
        try {
          for (let index = 0; index < compileRuns; index += 1) {
            const material = makeChannelMaterial();
            const buster = createShaderCacheBuster(`${profileRunId}_${identity}_${index}`)!;
            material.colorNode = buster.vec3(colorNode);
            material.needsUpdate = true;
            measuredMaterial?.dispose();
            measuredMaterial = material;
            const compileStartedAt = performance.now();
            await compileMaterialAsync(renderer, material, target);
            compileSamples.push(performance.now() - compileStartedAt);
          }
          const { vertexShader, fragmentShader } = await inspectMaterialShaderAsync(
            renderer,
            measuredMaterial!,
            target,
          );
          return {
            material: measuredMaterial!,
            pipelineCompileMs: median(compileSamples),
            vertexShader,
            fragmentShader,
          };
        } catch (error) {
          measuredMaterial?.dispose();
          throw error;
        }
      };

      const measure = async (
        colorNode: MaterialValue,
        identity: string,
        consoleLabel?: string,
      ) => {
        const prepared = await prepare(colorNode, identity);
        try {
          await gpuSample(prepared.material);
          const gpuSamples: number[] = [];
          for (let index = 0; index < runs; index += 1) {
            gpuSamples.push(await gpuSample(prepared.material));
          }
          const gpuMs = median(gpuSamples);
          if (opts.logCompiledShaders && consoleLabel) {
            console.groupCollapsed(`[material-profiler] ${consoleLabel}`);
            logCompiledVariant("Compiled subtree material", prepared, gpuMs);
            console.groupEnd();
          }
          return {
            pipelineCompileMs: prepared.pipelineCompileMs,
            gpuMs,
            fragmentShader: prepared.fragmentShader,
          };
        } finally {
          prepared.material.dispose();
        }
      };

      const measurePair = async (
        isolatedNode: MaterialValue,
        baselineNode: MaterialValue,
        identity: string,
        consoleLabel?: string,
      ) => {
        const isolated = await prepare(isolatedNode, `${identity}_isolated`);
        let baseline: PreparedProfileMaterial | null = null;
        try {
          baseline = await prepare(baselineNode, `${identity}_baseline`);
          await gpuSample(baseline.material);
          await gpuSample(isolated.material);
          const isolatedSamples: number[] = [];
          const baselineSamples: number[] = [];
          const deltaSamples: number[] = [];
          for (let index = 0; index < runs; index += 1) {
            let isolatedMs: number;
            let baselineMs: number;
            if (index % 2 === 0) {
              baselineMs = await gpuSample(baseline.material);
              isolatedMs = await gpuSample(isolated.material);
            } else {
              isolatedMs = await gpuSample(isolated.material);
              baselineMs = await gpuSample(baseline.material);
            }
            isolatedSamples.push(isolatedMs);
            baselineSamples.push(baselineMs);
            deltaSamples.push(isolatedMs - baselineMs);
          }
          const isolatedGpuMs = median(isolatedSamples);
          const baselineGpuMs = median(baselineSamples);
          const gpuPairedDeltaMs = median(deltaSamples);
          if (opts.logCompiledShaders && consoleLabel) {
            console.groupCollapsed(`[material-profiler] ${consoleLabel}`);
            console.log("Paired GPU delta", gpuPairedDeltaMs);
            logCompiledVariant("Isolated node material", isolated, isolatedGpuMs);
            logCompiledVariant("Matched baseline material", baseline, baselineGpuMs);
            console.groupEnd();
          }
          return {
            isolated: {
              pipelineCompileMs: isolated.pipelineCompileMs,
              gpuMs: isolatedGpuMs,
              fragmentShader: isolated.fragmentShader,
            },
            baseline: {
              pipelineCompileMs: baseline.pipelineCompileMs,
              gpuMs: baselineGpuMs,
              fragmentShader: baseline.fragmentShader,
            },
            gpuPairedDeltaMs,
          };
        } finally {
          isolated.material.dispose();
          baseline?.material.dispose();
        }
      };

      const floor = await measure(vec3(0.5, 0.5, 0.5), "floor");
      report.overheadMs = floor.gpuMs;
      report.compileOverheadMs = floor.pipelineCompileMs;

      for (const { node, output, hasConnectedInputs } of profilableNodeOutputs(
        graph.document,
        graph.getRegistry(),
        opts.nodeIds,
      )) {
        const row: NodeProfileRow = {
          nodeId: node.id,
          type: node.type,
          label: node.label,
          outputKey: output.key,
          outputLabel: output.label,
          outputKind: output.kind,
          graphCompileMs: 0,
          isolatedGraphCompileMs: 0,
          subtreeCompileMs: 0,
          subtreeGpuMs: 0,
          isolatedCompileMs: 0,
          isolatedGpuMs: 0,
          baselineCompileMs: 0,
          baselineGpuMs: 0,
          compileMs: 0,
          gpuMs: 0,
          workload: profileWorkload(node, output),
        };
        report.nodes.push(row);
        let subtreeNode: MaterialValue | undefined;
        let isolatedNode: MaterialValue | undefined;
        let baselineNode: MaterialValue | undefined;
        const identity = `${node.id}_${output.key}`;

        try {
          const graphStartedAt = performance.now();
          const { bundle } = graph.compileBundle({
            backend: "offline",
            soloNodeId: node.id,
            soloOutputKey: output.key,
          });
          row.graphCompileMs = performance.now() - graphStartedAt;
          subtreeNode = bundle.baseColor;

          if (hasConnectedInputs) {
            const isolatedStartedAt = performance.now();
            const isolated = graph.compileBundle({
              backend: "offline",
              soloNodeId: node.id,
              soloOutputKey: output.key,
              transformNodeInputs: (ctx) => isolateInputs(ctx, node.id),
            });
            row.isolatedGraphCompileMs = performance.now() - isolatedStartedAt;
            isolatedNode = isolated.bundle.baseColor;

            const baseline = graph.compileBundle({
              backend: "offline",
              soloNodeId: node.id,
              soloOutputKey: output.key,
              transformNodeInputs: (ctx) => isolateInputs(ctx, node.id),
              transformNodeOutputs: (ctx) => replaceWithBaseline(ctx, node.id, output),
            });
            baselineNode = baseline.bundle.baseColor;
          } else {
            row.isolatedGraphCompileMs = row.graphCompileMs;
            isolatedNode = subtreeNode;
          }
        } catch (error) {
          row.error = error instanceof Error ? error.message : String(error);
          continue;
        }

        if (!subtreeNode || !isolatedNode || (hasConnectedInputs && !baselineNode)) {
          row.error = `no solo output '${output.key}'`;
          continue;
        }

        try {
          const consoleLabel = `${node.label ?? node.id} · ${output.label ?? output.key} (${node.type})`;
          const subtree = await measure(
            subtreeNode,
            `${identity}_subtree`,
            `${consoleLabel} · ancestor subtree`,
          );
          row.subtreeCompileMs = subtree.pipelineCompileMs;
          row.subtreeGpuMs = subtree.gpuMs;
          const pair = await measurePair(
            isolatedNode,
            baselineNode ?? vec3(0.5, 0.5, 0.5),
            identity,
            `${consoleLabel} · isolated node vs matched baseline`,
          );
          row.isolatedCompileMs = pair.isolated.pipelineCompileMs;
          row.isolatedGpuMs = pair.isolated.gpuMs;
          row.baselineCompileMs = pair.baseline.pipelineCompileMs;
          row.baselineGpuMs = pair.baseline.gpuMs;
          row.gpuPairedDeltaMs = pair.gpuPairedDeltaMs;
          row.shaderMetrics = measureNodeShaderMetrics(
            pair.isolated.fragmentShader,
            pair.baseline.fragmentShader,
          );
        } catch (error) {
          row.error = error instanceof Error ? error.message : String(error);
        }
      }

      deriveMeasuredNodeCosts(report.nodes);
      report.nodes.sort((a, b) => b.compileMs - a.compileMs || b.gpuMs - a.gpuMs);
      return report;
    } finally {
      if (timestampTrackingEnabled) {
        try {
          await renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);
        } catch {
          // Preserve the original profiling error; timestamp cleanup is best effort.
        }
      }
      if (timestampBackend) timestampBackend.trackTimestamp = previousTimestampTracking;
      target.dispose();
    }
  });
}
