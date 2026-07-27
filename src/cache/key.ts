import { REVISION } from "three";
import { MATERIAL_DOCUMENT_VERSION } from "../document";
import { MATERIAL_RUNTIME_VERSION } from "../version";
import { createMaterialParamKey, createMaterialTopologyKey } from "../topology";
import type { NodeRegistry } from "../graph/registry";
import type { MaterialGraphDocument } from "../graph/types";
import type { BakeCacheChannel } from "./types";

// Record SHAPE. Bump when BakeCacheEntry's fields change in a way an older/newer build would misread.
export const BAKE_CACHE_VERSION = 1;

// The bake-OUTPUT convention. Bump this whenever the same document would produce different texels:
//   - SS (channel-baker.ts) or downsampleNode's filter
//   - encodeChannel, FIELD_CHANNELS, COLOR_CHANNELS  (the colour-space contract)
//   - makeChannelTarget's format / filtering / colorSpace / anisotropy
// Getting this wrong means restoring texels that no longer match what a fresh bake would produce, which is
// invisible until someone compares renders. When in doubt, bump it: the cost is one cold cache.
export const BAKE_ENCODER_VERSION = 1;

// Version prefix, embedded in every id. A bump to ANY component orphans every existing entry — they are
// never looked up again — and gc() deletes them on the next open. This is the whole invalidation story for
// runtime upgrades, so it must include everything that can change texels but not the document.
// MATERIAL_RUNTIME_VERSION is in here because node maths ships without a document-schema bump; see version.ts.
export const BAKE_CACHE_ID_PREFIX =
  `mdbc${BAKE_CACHE_VERSION}.${BAKE_ENCODER_VERSION}.${MATERIAL_DOCUMENT_VERSION}.${MATERIAL_RUNTIME_VERSION}`;

// The schema tag stored on every record, so gc() can spot foreign entries without parsing ids.
export const BAKE_CACHE_SCHEMA = BAKE_CACHE_ID_PREFIX;

export interface BakeCacheKeyInput {
  document: MaterialGraphDocument;
  registry: NodeRegistry;
  size: number;
  channels: readonly BakeCacheChannel[];
  // Defaults to "webgpu". Present so a future backend with different texel output can't collide.
  backend?: string;
  namespace?: string;
}

export interface BakeCacheKey {
  // Short, storage-safe index key: `<prefix>-<hash>-<len>`.
  id: string;
  // The full canonical body `id` hashes. Stored in the record and compared on read, so a hash collision is a
  // miss rather than a wrong-texture bug — which is why a non-cryptographic hash is fine here.
  key: string;
}

// FNV-1a, 64-bit, as two 32-bit lanes so we never touch BigInt (this runs on every bake and every read).
// Not cryptographic and doesn't need to be: collisions are caught by the canonical-key comparison on read.
//
// The 64-bit multiply by the FNV prime 0x100000001B3 is done in 16-bit limbs. Prime limbs are
// p0=0x01B3, p1=0, p2=0x0100, p3=0, so most cross terms drop out. Every intermediate stays below 2^32
// (worst case ~45.3M), which is what makes the `>>> 16` carries valid.
export function fnv1a64(text: string): string {
  let hi = 0xcbf29ce4; // offset basis 0xcbf29ce484222325
  let lo = 0x84222325;
  for (let i = 0; i < text.length; i++) {
    lo = (lo ^ (text.charCodeAt(i) & 0xff)) >>> 0;
    const l0 = lo & 0xffff;
    const l1 = lo >>> 16;
    const h0 = hi & 0xffff;
    const h1 = hi >>> 16;
    const c0 = l0 * 0x01b3;
    const c1 = l1 * 0x01b3 + (c0 >>> 16);
    const c2 = h0 * 0x01b3 + l0 * 0x0100 + (c1 >>> 16);
    const c3 = h1 * 0x01b3 + l1 * 0x0100 + (c2 >>> 16);
    lo = (((c1 & 0xffff) << 16) | (c0 & 0xffff)) >>> 0;
    hi = (((c3 & 0xffff) << 16) | (c2 & 0xffff)) >>> 0;
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

// Build the identity of a bake. Everything that can change a texel goes in; nothing cosmetic does.
//
// The canonical body is newline-joined and human-readable on purpose: when a cache entry misbehaves, diffing
// two keys tells you immediately which component changed.
export function createBakeCacheKey(input: BakeCacheKeyInput): BakeCacheKey {
  const { document, registry, size, channels, backend = "webgpu", namespace = "" } = input;
  const key = [
    BAKE_CACHE_ID_PREFIX,
    `three:${REVISION}`,
    `backend:${backend}`,
    `ns:${namespace}`,
    `size:${size}`,
    `ch:${[...channels].sort().join(",")}`,
    `topo:${createMaterialTopologyKey(document, registry)}`,
    `params:${createMaterialParamKey(document, registry)}`,
  ].join("\n");
  // Length is a cheap second dimension: two colliding hashes almost never share a canonical length, so an
  // accidental collision is rarer still before the canonical comparison on read even runs.
  return { id: `${BAKE_CACHE_ID_PREFIX}-${fnv1a64(key)}-${key.length.toString(36)}`, key };
}
