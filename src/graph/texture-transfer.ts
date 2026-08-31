import * as THREE from "three";
import type { RenderTarget, WebGPURenderer } from "three/webgpu";
import { configureChannelTexture } from "./channel-baker";
import type { PbrSocket } from "./types";

// Moving baked texels between a RenderTarget and CPU memory, for the persistent bake cache.
//
// The capture direction reads back and flips to top-down; the restore direction flips back and does a
// GPU-to-GPU copy. Because BOTH directions apply the same flip, the round trip is the identity no matter what
// row order the device actually hands us — orientation is not something this module has to get right, only
// something it has to be consistent about.

// Tightly-packed RGBA8 byte length for a square channel.
export function channelByteLength(size: number): number {
  return size * size * 4;
}

// WebGPU requires a 256-byte-aligned `bytesPerRow` for a texture→buffer copy, and three passes the padded
// buffer straight through (WebGPUTextureUtils.copyTextureToBuffer returns the whole mapped range). So for any
// width where `width * 4` is not a multiple of 256 — i.e. width not a multiple of 64 — the rows arrive with
// gaps and the final row is short.
export function paddedBytesPerRow(width: number): number {
  return Math.ceil((width * 4) / 256) * 256;
}

// Strip row padding, if there is any. Detection is by length rather than by arithmetic on the width, because
// the WebGL2 fallback's `readPixels` returns tight rows regardless — so "already tight" is a real case we must
// pass through untouched rather than mangle.
export function depadRows(buffer: Uint8Array, width: number, height: number): Uint8Array {
  const tightStride = width * 4;
  const tightLength = tightStride * height;
  if (buffer.length === tightLength) return buffer;
  const bytesPerRow = paddedBytesPerRow(width);
  const out = new Uint8Array(tightLength);
  for (let y = 0; y < height; y++) {
    const src = y * bytesPerRow;
    out.set(buffer.subarray(src, src + tightStride), y * tightStride);
  }
  return out;
}

// Reverse row order into a new buffer. Its own inverse, which is the property the capture/restore round trip
// leans on.
export function flipRows(buffer: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  flipRowsInto(buffer, out, width, height);
  return out;
}

// Same, into a caller-owned destination — used on the restore path so a 4MB channel doesn't allocate twice.
export function flipRowsInto(
  buffer: Uint8Array,
  out: Uint8Array,
  width: number,
  height: number,
): void {
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * stride;
    out.set(buffer.subarray(src, src + stride), y * stride);
  }
}

// Read a render target's texels as tightly-packed, top-down RGBA8.
//
// Distinct from MaterialBakeService.readImage: that recompiles a colorNode into a scratch target for PNG
// export / the 2D preview. This reads an EXISTING baked target with no compile and no render.
export async function readTargetTexels(
  renderer: WebGPURenderer,
  rt: RenderTarget,
): Promise<Uint8Array> {
  const { width, height } = rt;
  const raw = (await renderer.readRenderTargetPixelsAsync(
    rt,
    0,
    0,
    width,
    height,
  )) as unknown as Uint8Array;
  return flipRows(depadRows(raw, width, height), width, height);
}

// Staging DataTextures, keyed by "<size>|<colorSpace>" — so at most two per size in use (one sRGB for the
// colour channels, one linear for the data channels). One staging texture serves EVERY channel of a restore:
// WebGPU queue operations are ordered, so channel N's copy reads the current contents before channel N+1's
// upload lands. Reported by transferPoolInfo() so a leak shows up as pool growth, the same way ssPoolInfo()
// works for the supersample pool.
const stagingPool = new Map<string, THREE.DataTexture>();

// `colorSpace` is taken straight off the destination texture, which three types loosely as a string.
function stagingTexture(size: number, colorSpace: string): THREE.DataTexture {
  const key = `${size}|${colorSpace || "none"}`;
  const existing = stagingPool.get(key);
  if (existing) return existing;
  const tex = new THREE.DataTexture(
    new Uint8Array(channelByteLength(size)),
    size,
    size,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  // Match the destination's colour space so three allocates the same GPU format. WebGPU copy-compatibility
  // would treat rgba8unorm and rgba8unorm-srgb as the same format for a copy anyway, but matching means we
  // never depend on that rule.
  tex.colorSpace = colorSpace as THREE.ColorSpace;
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  // Upload the bytes verbatim — this module owns orientation, and a backend-side flip would fight it.
  tex.flipY = false;
  tex.needsUpdate = true;
  stagingPool.set(key, tex);
  return tex;
}

export function transferPoolInfo(): string[] {
  return [...stagingPool.keys()];
}

export function disposeTransferPool(): void {
  for (const tex of stagingPool.values()) tex.dispose();
  stagingPool.clear();
}

// Build a standalone, sampleable texture from cached texels — no renderer, no render target, no GPU work at
// call time. This is what lets a consumer hydrate a plain THREE material straight from the cache before (or
// entirely without) attaching a WebGPURenderer.
//
// Orientation: the incoming texels are top-down (that is the cache's storage convention), and this flips them
// to the GPU-native order that `flipY = false` uploads verbatim — exactly what writeTargetTexels does into a
// render target. Since that round trip is byte-exact against a real bake, matching it here means a hydrated
// texture has the same GPU layout as the baked target and therefore samples identically.
export function channelDataTexture(
  texels: Uint8Array,
  size: number,
  channel: PbrSocket | "height" | "arm",
): THREE.DataTexture {
  const data = flipRows(texels, size, size);
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  // Same colour-space / wrap / mip contract the bake targets get, so lighting matches a fresh bake.
  configureChannelTexture(tex, channel);
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

// Write top-down RGBA8 texels into an existing render target's texture.
//
// This is a queue-level GPU copy, not a render: no shader, no pipeline, no fullscreen quad. Three's
// WebGPUBackend.copyTextureToTexture also regenerates the destination's mipmaps when it has
// `generateMipmaps` (which every channel target does), so a restored channel is trilinear-correct exactly
// like a freshly baked one.
//
// Critically, `rt.texture` is never replaced — so the surface material keeps sampling the same THREE.Texture
// object it was wired to, with all its sampler settings intact, and no rewire is needed. That stable-object
// contract is what the whole TexturedSurface design rests on ("Destroyed texture used in a submit").
export function writeTargetTexels(
  renderer: WebGPURenderer,
  rt: RenderTarget,
  texels: Uint8Array,
): void {
  const { width, height } = rt;
  if (texels.length !== width * height * 4) {
    throw new Error(
      `texel length ${texels.length} does not match target ${width}x${height} (expected ${width * height * 4})`,
    );
  }
  // A target that has never been rendered into has no GPU texture yet, and the copy needs one. This is the
  // sanctioned way to force full allocation.
  renderer.initRenderTarget(rt);
  const staging = stagingTexture(width, rt.texture.colorSpace);
  flipRowsInto(texels, staging.image.data as Uint8Array, width, height);
  staging.needsUpdate = true;
  renderer.copyTextureToTexture(staging, rt.texture);
}
