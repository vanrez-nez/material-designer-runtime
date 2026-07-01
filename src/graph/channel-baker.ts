import { QuadMesh, RenderTarget, MeshBasicNodeMaterial, type WebGPURenderer } from "three/webgpu";
import { NoColorSpace, NearestFilter, RepeatWrapping, Scene, OrthographicCamera } from "three";
import { vec3, vec2, sRGBTransferOETF, texture, uniform, uv, normalize } from "three/tsl";
import type { MaterialValue, PbrSocket } from "./types";

// Colour-management convention (plan L5 / Phase 6): the graph works in LINEAR space, and a baked texture
// follows texture convention — colour channels are sRGB-encoded (display), data channels stay linear.
// Scalar-field channels render as linear grayscale; colour channels get the sRGB OETF; normal is already
// an encoded [0,1] vector (from normal-from-height) and stays linear/raw.
export const FIELD_CHANNELS: PbrSocket[] = ["roughness", "metallic", "ambientOcclusion"];
export const COLOR_CHANNELS: PbrSocket[] = ["baseColor", "emission"];

// Per-channel encoding into a renderable colorNode. Shared by the channel baker (preview/PNG) and the
// offline surface baker so both produce identical texels (and the offline RT's colorSpace lines up).
export function encodeChannel(node: MaterialValue, channel: PbrSocket): MaterialValue {
  if (FIELD_CHANNELS.includes(channel)) return vec3(node); // linear grayscale data
  if (COLOR_CHANNELS.includes(channel)) return sRGBTransferOETF(node); // sRGB-encode (display convention)
  return node; // normal / other: already-encoded vector data, leave linear
}

// Supersampled fullscreen-quad baker. A single-sample point bake aliases any high-frequency procedural
// content (Wave at tens–hundreds of cycles, near-step Color Ramps, noise) into hard edges — and makes the
// screen-space normal derivative unusable except at a near-zero strength. So we render the channel at SS×
// the target into a raw high-res RT, then box-downsample SS×SS taps into the destination — matching
// Blender's anti-aliased bake. (MSAA on the RT would not help: it only anti-aliases geometry edges, not
// the shader content of a fullscreen quad.) Module-level singletons: bakes are synchronous.
// SS=2 (2×2) renders the intermediate at 2× the target, not 4× — 4× less GPU work than SS=4 — and combined
// with the channel mipmaps + anisotropy is adequate AA. (SS is a build-time constant: the downsample node
// below unrolls SS×SS taps, so changing it rebuilds those quads, not a runtime knob.)
const SS = 2;
// One reusable fullscreen quad; its material is SWAPPED per render. Each channel keeps its OWN persistent
// material (makeChannelMaterial), so re-rendering after only a uniform changed reuses the compiled pipeline
// — no WGSL/pipeline recompile. (Reassigning a material's colorNode + needsUpdate is what forces a recompile.)
const bakeQuad = new QuadMesh(new MeshBasicNodeMaterial());
// Scratch material for one-off raw-colorNode renders (PNG export / 2D preview via renderColorNodeToTarget).
// That path recompiles per call, which is fine for non-interactive one-offs.
const scratchMat = new MeshBasicNodeMaterial();

// Raw high-res intermediate: stores the already-encoded channel values verbatim (no colorspace / filtering
// so the box taps read exact texels). Resized in place so the prebuilt downsample nodes keep referencing it.
const ssRT = new RenderTarget(SS, SS);
ssRT.texture.colorSpace = NoColorSpace;
ssRT.texture.minFilter = ssRT.texture.magFilter = NearestFilter;
ssRT.texture.wrapS = ssRT.texture.wrapT = RepeatWrapping; // box taps at tile edges wrap, not clamp
const ssTexel = uniform(vec2(1 / SS, 1 / SS)); // 1 / high-res size, set per bake

// Box filter: average the SS×SS high-res texels covering each destination texel. The normal channel must
// average decoded vectors (raw encoded [0,1] normals don't average linearly), then renormalize + re-encode.
function downsampleNode(isNormal: boolean): MaterialValue {
  const c = (SS - 1) / 2;
  let acc: MaterialValue = vec3(0, 0, 0);
  for (let j = 0; j < SS; j++)
    for (let i = 0; i < SS; i++) {
      const off = vec2(i - c, j - c).mul(ssTexel);
      let s: MaterialValue = texture(ssRT.texture, uv().add(off)).xyz;
      if (isNormal) s = s.mul(2).sub(1);
      acc = acc.add(s);
    }
  acc = acc.div(SS * SS);
  return isNormal ? normalize(acc).mul(0.5).add(0.5) : acc;
}
const downColorMat = new MeshBasicNodeMaterial();
downColorMat.colorNode = downsampleNode(false);
const downNormalMat = new MeshBasicNodeMaterial();
downNormalMat.colorNode = downsampleNode(true);
const downColorQuad = new QuadMesh(downColorMat);
const downNormalQuad = new QuadMesh(downNormalMat);

// A persistent per-channel bake material. The caller assigns `.colorNode` (+ `needsUpdate`) ONCE per compile;
// re-rendering it later with only changed uniform values reuses its pipeline (no recompile).
export function makeChannelMaterial(): MeshBasicNodeMaterial {
  return new MeshBasicNodeMaterial();
}

// One throwaway scene of fullscreen quads used ONLY to pre-compile bake pipelines (never rendered from).
// QuadMesh shares one module geometry, and three's render pipeline cache key is (shader stages, material
// render-state, render-target format, scale-sign) — NOT mesh identity — so a pipeline compiled on these
// quads against `ssRT` is the exact one `bakeQuad` reuses when it renders the same material into `ssRT`.
const compileScene = new Scene();
const compileCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
const compileQuads: QuadMesh[] = [];

// Pre-compile every channel's render pipeline OFF the blocking path, IN PARALLEL. The normal render path
// (`bakeQuad.render`) hits three's synchronous `device.createRenderPipeline`, which on Dawn/Metal defers
// the heavy shader compile to submit time and pegs the GPU process — a single structural edit on a heavy
// graph freezes the editor for seconds. `renderer.compileAsync` instead routes through
// `createRenderPipelineAsync` (non-blocking) and, given a scene of N materials, fires all N compiles then
// awaits them together — so wall time is ~max(channel) instead of the serial sum. After this resolves the
// per-channel `renderMaterialToTarget` calls find warm pipelines and render in ~ms. Caller must serialise:
// a single `compileAsync` manages shared renderer state safely, but two concurrent ones would clobber it.
export async function compileMaterialsAsync(
  renderer: WebGPURenderer,
  materials: MeshBasicNodeMaterial[],
): Promise<void> {
  while (compileQuads.length < materials.length) compileQuads.push(new QuadMesh());
  compileScene.clear();
  for (let i = 0; i < materials.length; i++) {
    compileQuads[i].material = materials[i];
    compileScene.add(compileQuads[i]);
  }
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(ssRT); // compile against the channel's actual target (format-matched pipeline)
  await renderer.compileAsync(compileScene, compileCamera);
  renderer.setRenderTarget(previous);
}

// Render a decomposition cache material DIRECTLY into its 16F target (no supersample intermediate — the SS
// path uses an 8-bit RT which would quantise the cached field). One quad, at the cache resolution; the
// final channel bake supersamples when it SAMPLES the cache. Reuses the shared `bakeQuad`.
export function renderCacheToTarget(
  renderer: WebGPURenderer,
  material: MeshBasicNodeMaterial,
  rt: RenderTarget,
): void {
  bakeQuad.material = material;
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  bakeQuad.render(renderer);
  renderer.setRenderTarget(previous);
}

// Render `material` (its colorNode already assigned) into `rt`, supersampled + box-downsampled. This does NOT
// touch colorNode/needsUpdate — so when the material is unchanged since its last compile it is a pure
// re-render (the uniform fast path). `isNormal` switches the downsample to vector-correct averaging.
export function renderMaterialToTarget(
  renderer: WebGPURenderer,
  material: MeshBasicNodeMaterial,
  rt: RenderTarget,
  isNormal = false,
): void {
  const w = rt.width;
  const h = rt.height;
  if (ssRT.width !== w * SS || ssRT.height !== h * SS) ssRT.setSize(w * SS, h * SS);
  ssTexel.value.set(1 / (w * SS), 1 / (h * SS));
  bakeQuad.material = material;
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(ssRT); // 1) render the channel at SS×
  bakeQuad.render(renderer);
  renderer.setRenderTarget(rt); // 2) box-downsample into the destination
  (isNormal ? downNormalQuad : downColorQuad).render(renderer);
  renderer.setRenderTarget(previous);
}

// One-off: render a raw `colorNode` into `rt` via the scratch material (recompiles each call). For PNG
// export / 2D preview — not the interactive surface path.
export function renderColorNodeToTarget(
  renderer: WebGPURenderer,
  colorNode: MaterialValue,
  rt: RenderTarget,
  isNormal = false,
): void {
  scratchMat.colorNode = colorNode;
  scratchMat.needsUpdate = true;
  renderMaterialToTarget(renderer, scratchMat, rt, isNormal);
}
