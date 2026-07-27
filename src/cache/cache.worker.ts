import { decodeTexels, encodeTexels } from "./codec";
import {
  dbNameFor,
  idbClear,
  idbDelete,
  idbGet,
  idbList,
  idbPut,
  idbTouch,
  openBakeCacheDb,
  toStandaloneBuffer,
  type StoredData,
} from "./idb-core";
import type { BakeCacheEncoding, BakeCacheEntry, BakeCacheEntryMeta } from "./types";

// The bake cache's worker: PNG encode/decode plus all IndexedDB IO, off the main thread.
//
// Why a worker at all — the main thread is doing the one thing a worker cannot (GPU readback), and PNG encoding
// a 1024² channel costs tens to low hundreds of milliseconds. Seven of those on the main thread would be a
// visible hitch on every bake, which would make the cache a worse experience than the compile it avoids.
//
// Buffers are TRANSFERRED in both directions, so the main thread never copies a 4MB channel; it hands over
// ownership and gets decoded ownership back.

interface WorkerRequest {
  id: number;
  op: "configure" | "get" | "put" | "touch" | "delete" | "list" | "clear" | "estimate";
  payload?: unknown;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

// The package's tsconfig uses the DOM lib (this is a browser runtime), where `self` is typed as a Window whose
// postMessage takes a targetOrigin. Pulling in the webworker lib alongside DOM collides on dozens of globals,
// so declare just the two members this file uses instead.
interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

let dbPromise: Promise<IDBDatabase> | null = null;
let dbName = dbNameFor("");
let encoding: BakeCacheEncoding = "png";

function db(): Promise<IDBDatabase> {
  // Cache the connection, but drop a REJECTED promise so one transient open failure doesn't poison every
  // later call for the life of the worker.
  if (!dbPromise) {
    dbPromise = openBakeCacheDb(dbName).catch((err: unknown) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

async function handleGet(id: string): Promise<{ entry: BakeCacheEntry | null; transfer: ArrayBuffer[] }> {
  const found = await idbGet(await db(), id);
  if (!found) return { entry: null, transfer: [] };
  const { meta, data } = found;
  // Decode every channel CONCURRENTLY. This is the dominant cost of a restore — image decoding is the slow
  // part, and doing seven of them in sequence made a hit feel like a small bake. createImageBitmap hands the
  // work to the browser's decode threads, so issuing them together overlaps what was previously serial.
  const textures = await Promise.all(
    data.textures.map(async (stored) => ({
      channel: stored.channel,
      // Decoded to plain RGBA8 here, so the main thread receives texels it can hand straight to the GPU with
      // no further work and no image-decode ambiguity.
      encoding: "rgba8" as const,
      bytes: await decodeTexels(new Uint8Array(stored.bytes), meta.size, stored.encoding),
    })),
  );
  return { entry: { ...meta, textures }, transfer: textures.map((t) => t.bytes.buffer as ArrayBuffer) };
}

async function handlePut(entry: BakeCacheEntry): Promise<void> {
  // Encode concurrently, for the same reason as the decode above.
  const encodedAll = await Promise.all(
    entry.textures.map(async (texels) => ({
      channel: texels.channel,
      encoded: await encodeTexels(texels.bytes, entry.size, encoding),
    })),
  );
  let storedBytes = 0;
  const textures = encodedAll.map(({ channel, encoded }) => {
    storedBytes += encoded.bytes.byteLength;
    return { channel, encoding: encoded.encoding, bytes: toStandaloneBuffer(encoded.bytes) };
  });
  // Record the size AS STORED, not the size handed to us. `metrics().bytes` and the LRU budget both read this,
  // and a "size taken" number that reported pre-compression bytes would simply be wrong.
  const meta: BakeCacheEntryMeta = { ...stripTextures(entry), bytes: storedBytes };
  const data: StoredData = { id: entry.id, textures };
  await idbPut(await db(), meta, data);
}

function stripTextures(entry: BakeCacheEntry): BakeCacheEntryMeta {
  const { textures: _textures, ...meta } = entry;
  return meta;
}

async function dispatch(req: WorkerRequest): Promise<{ result?: unknown; transfer?: ArrayBuffer[] }> {
  switch (req.op) {
    case "configure": {
      const { namespace, encoding: enc } = req.payload as {
        namespace?: string;
        encoding?: BakeCacheEncoding;
      };
      const nextName = dbNameFor(namespace ?? "");
      if (nextName !== dbName) {
        // Close the old connection before switching, or it blocks the new one.
        void dbPromise?.then((handle) => handle.close()).catch(() => undefined);
        dbPromise = null;
        dbName = nextName;
      }
      if (enc) encoding = enc;
      return { result: { ok: true } };
    }
    case "get": {
      const { entry, transfer } = await handleGet(req.payload as string);
      return { result: entry, transfer };
    }
    case "put":
      await handlePut(req.payload as BakeCacheEntry);
      return {};
    case "touch": {
      const { id, lastUsedAt } = req.payload as { id: string; lastUsedAt: number };
      await idbTouch(await db(), id, lastUsedAt);
      return {};
    }
    case "delete":
      await idbDelete(await db(), req.payload as string);
      return {};
    case "list":
      return { result: await idbList(await db()) };
    case "clear":
      await idbClear(await db());
      return {};
    case "estimate": {
      const metas = await idbList(await db());
      let bytes = 0;
      for (const meta of metas) bytes += meta.bytes;
      return { result: { entries: metas.length, bytes } };
    }
    default:
      throw new Error(`unknown cache worker op: ${String(req.op)}`);
  }
}

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  try {
    const { result, transfer } = await dispatch(req);
    const response: WorkerResponse = { id: req.id, ok: true, result };
    // Transfer the decoded texel buffers back rather than copying them — a 28MB restore costs the main thread
    // no memcpy, just ownership.
    scope.postMessage(response, transfer ?? []);
  } catch (err) {
    // Errors travel as strings: an Error instance does not survive structured clone with its stack intact, and
    // the client only needs the message to record in `lastError`.
    const response: WorkerResponse = {
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    scope.postMessage(response);
  }
};
