import type { MaterialNodeDef, MaterialValue } from "../../types";
import { tilePattern, hexPattern } from "../../../tsl/tile";

type V = MaterialValue;

const LATTICES = ["square", "hex"];

// Tile Generator — a generic Substance-style grid generator, not brick-specific. It places a rounded-rect
// tile per grid cell with a per-row offset and per-tile randomisation of position / size / rotation / value.
// Presets of THIS one node:
//   running-bond brick : offset 0.5, offset every 2, columns≈½ rows, small gap
//   stack-bond tile    : offset 0
//   planks             : columns 1 (or rows 1)
//   cobblestone        : roundness high + size/position/rotation randomness
// Outputs `mask` (1 on a tile, 0 in the grout → AO / height / colour mask), and `value` (per-tile random →
// colour / roughness / luminance variation). Composite colour downstream, e.g.
// `Blend(groutColor, Blend(tileA, tileB, value), mask)`. Seamless in the offline bake.
export const tileNode: MaterialNodeDef = {
  type: "tile",
  nodeClass: "texture",
  label: "Tile Generator",
  inputs: [{ key: "coord", kind: "vector" }],
  outputs: [
    { key: "mask", label: "Mask", kind: "float" },
    { key: "value", label: "Value", kind: "float" },
    // Per-cell coordinate frame + extra randoms, so each tile can carry its own oriented detail. cellCoord is
    // the fragment position local to the winning tile (cell units, ~[-0.5,0.5]) — rotate it (Vector Rotate,
    // angle from cellRandom) to give every tile an independent grain/print direction. cellRandom is three
    // decorrelated per-tile randoms. Both stay seamless in the offline bake (wrapped per-cell hash).
    { key: "cellCoord", label: "Cell Coord", kind: "vector" },
    { key: "cellRandom", label: "Cell Random", kind: "vector" },
  ],
  params: [
    { key: "lattice", label: "lattice", type: "select", options: LATTICES, default: "square" },
    { key: "columns", label: "columns", type: "int", min: 1, max: 32, step: 1, default: 6 },
    { key: "rows", label: "rows", type: "int", min: 1, max: 64, step: 1, default: 12 },
    { key: "offset", label: "row offset", type: "float", min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: "offsetFreq", label: "offset every", type: "int", min: 1, max: 6, step: 1, default: 2 },
    { key: "gap", label: "gap", type: "float", min: 0, max: 0.08, step: 0.001, default: 0.012 },
    { key: "roundness", label: "roundness", type: "float", min: 0, max: 1, step: 0.01, default: 0.05 },
    { key: "edge", label: "edge soft", type: "float", min: 0, max: 0.05, step: 0.001, default: 0.004 },
    { key: "sizeRandom", label: "size rand", type: "float", min: 0, max: 1, step: 0.01, default: 0 },
    { key: "posRandom", label: "pos rand", type: "float", min: 0, max: 1, step: 0.01, default: 0 },
    { key: "rotRandom", label: "rot rand", type: "float", min: 0, max: 1, step: 0.01, default: 0 },
  ],
  build(ctx) {
    const coord = (ctx.inputs.coord ?? ctx.coord) as V;
    const columns = Math.max(1, Math.round(Number(ctx.constant("columns") ?? 6)));

    // Hex lattice: a regular honeycomb. Row count is derived from columns (×2/√3, snapped even) so the
    // hexagons stay regular AND the tile wraps; columns/rows aspect, offset, and the SDF params don't apply.
    if ((ctx.constant("lattice") as string) === "hex") {
      const hexRows = Math.max(2, Math.round((columns * 2) / Math.sqrt(3) / 2) * 2);
      const { mask, value, cellCoord, cellRandom } = hexPattern(
        coord,
        columns,
        hexRows,
        ctx.live("gap") as V,
        ctx.live("edge") as V,
      );
      return { mask, value, cellCoord, cellRandom };
    }

    const offsetFreq = Math.max(1, Math.round(Number(ctx.constant("offsetFreq") ?? 2)));
    // Snap rows up to a multiple of offsetFreq so the offset cycle closes at the tile's top edge (seamless).
    const rawRows = Math.max(1, Math.round(Number(ctx.constant("rows") ?? 12)));
    const rows = Math.ceil(rawRows / offsetFreq) * offsetFreq;

    const { mask, value, cellCoord, cellRandom } = tilePattern(
      coord,
      { columns, rows, offsetFreq },
      {
        rowOffset: ctx.live("offset") as V,
        gap: ctx.live("gap") as V,
        roundness: ctx.live("roundness") as V,
        edge: ctx.live("edge") as V,
        sizeRandom: ctx.live("sizeRandom") as V,
        posRandom: ctx.live("posRandom") as V,
        rotRandom: ctx.live("rotRandom") as V,
      },
    );
    return { mask, value, cellCoord, cellRandom };
  },
};
