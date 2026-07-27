import type { BakeCacheEncoding } from "./types";

// Texel codec. Runs in the cache worker, and on the main thread when no worker is available.
//
// PNG is lossless as a format, but a canvas round trip is only byte-exact if you fight two defaults:
//
//  1. **Canvas 2D stores PREMULTIPLIED pixels.** With any alpha below 255 the RGB is destroyed on the way in
//     and cannot be recovered. Baked channels are opaque (the bake materials have no transparency), so we
//     force alpha to 255 on encode and rebuild it as 255 on decode. That makes premultiplication a no-op
//     rather than something we hope doesn't bite.
//  2. **The browser will colour-manage an image if you let it.** Our field channels (roughness, metallic, AO,
//     height) hold LINEAR data and `normal` holds an encoded vector — applying an sRGB transform to those
//     would corrupt them silently. `colorSpaceConversion: "none"` on decode plus a pinned `srgb` canvas in
//     both directions means no transform is ever applied; the bytes are carried, not interpreted.
//
// Both are verified by a byte-identity test rather than assumed — see `pngRoundTripIsLossless`.

// PNG needs OffscreenCanvas + createImageBitmap, which exist in a worker but not in node (so tests and any
// SSR path fall back to raw).
export function canEncodePng(): boolean {
  return (
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap !== "undefined" &&
    typeof ImageData !== "undefined"
  );
}

function context2d(size: number): OffscreenCanvasRenderingContext2D {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d", {
    // Pin the colour space in BOTH directions so the browser never converts our linear data.
    colorSpace: "srgb",
    willReadFrequently: true,
  }) as OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
  return ctx;
}

export async function encodePng(texels: Uint8Array, size: number): Promise<Uint8Array> {
  // Copy so we never mutate the caller's buffer, and force alpha opaque (see note 1).
  const rgba = new Uint8ClampedArray(texels.length);
  rgba.set(texels);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const ctx = context2d(size);
  ctx.putImageData(new ImageData(rgba, size, size, { colorSpace: "srgb" }), 0, 0);
  const blob = await ctx.canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

export async function decodePng(bytes: Uint8Array, size: number): Promise<Uint8Array> {
  const blob = new Blob([bytes as BlobPart], { type: "image/png" });
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  try {
    const ctx = context2d(size);
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, size, size, { colorSpace: "srgb" }).data;
    const out = new Uint8Array(data.length);
    out.set(data);
    // Alpha is 255 by construction on encode; restate it so a decoder quirk can't leak a stray value into a
    // channel that a consumer might read as data.
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    return out;
  } finally {
    bitmap.close();
  }
}

// --- byte compression -------------------------------------------------------------------------------
// The middle ground between raw and PNG: shrink the texels with the browser's built-in byte compressor
// instead of an image codec. Lossless, no canvas, no ImageBitmap, no colour management to get wrong — so
// unpacking is ordinary decompression rather than image decoding, which is what makes PNG restores slow.
//
// "deflate-raw" rather than gzip: same algorithm, without the header/checksum we have no use for.
export function canDeflate(): boolean {
  return typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";
}

async function pipeThrough(
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform as ReadableWritablePair);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function deflateBytes(bytes: Uint8Array): Promise<Uint8Array> {
  return pipeThrough(bytes, new CompressionStream("deflate-raw"));
}

export function inflateBytes(bytes: Uint8Array): Promise<Uint8Array> {
  return pipeThrough(bytes, new DecompressionStream("deflate-raw"));
}

// Encode tightly-packed RGBA8 for storage. Falls back to raw whenever the requested codec isn't available,
// and reports which encoding was ACTUALLY used — each record is self-describing, so a store written by one
// engine (or an older build) still reads correctly on another.
export async function encodeTexels(
  texels: Uint8Array,
  size: number,
  encoding: BakeCacheEncoding,
): Promise<{ bytes: Uint8Array; encoding: BakeCacheEncoding }> {
  if (encoding === "png" && canEncodePng()) {
    return { bytes: await encodePng(texels, size), encoding: "png" };
  }
  if (encoding === "deflate" && canDeflate()) {
    return { bytes: await deflateBytes(texels), encoding: "deflate" };
  }
  return { bytes: texels, encoding: "rgba8" };
}

// Decode back to tightly-packed RGBA8. Throws on a size mismatch rather than returning a short buffer, so a
// corrupt record surfaces as a cache miss instead of a garbled texture.
export async function decodeTexels(
  bytes: Uint8Array,
  size: number,
  encoding: BakeCacheEncoding,
): Promise<Uint8Array> {
  let out = bytes;
  if (encoding === "png") out = await decodePng(bytes, size);
  else if (encoding === "deflate") out = await inflateBytes(bytes);
  const expected = size * size * 4;
  if (out.length !== expected) {
    throw new Error(`decoded ${out.length} bytes, expected ${expected} for ${size}x${size}`);
  }
  return out;
}

// Self-check used as a gate: encode then decode a representative pattern and confirm every byte survives.
// Exposed so the browser-side verification (and a consumer worried about a specific engine) can prove the
// premultiply / colour-management handling actually holds here rather than trusting the comments above.
export async function pngRoundTripIsLossless(size = 64): Promise<boolean> {
  if (!canEncodePng()) return false;
  const src = new Uint8Array(size * size * 4);
  for (let i = 0; i < src.length; i += 4) {
    // A spread of values including the extremes, where a transfer-function bug shows up worst.
    src[i] = i % 256;
    src[i + 1] = (i * 7) % 256;
    src[i + 2] = (i * 13) % 256;
    src[i + 3] = 255;
  }
  const encoded = await encodePng(src, size);
  const decoded = await decodePng(encoded, size);
  if (decoded.length !== src.length) return false;
  for (let i = 0; i < src.length; i++) if (src[i] !== decoded[i]) return false;
  return true;
}
