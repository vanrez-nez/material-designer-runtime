import { Fn, float, int, vec3, floor } from "three/tsl";
import type { MaterialValue } from "../graph/types";

// Voronoi over a CPU-relaxed (Lloyd / centroidal) periodic point set — gives natural mud-crack cells
// (equiaxed, no slivers, no squares) that plain jittered-grid Voronoi can't. The seed of each cell is no
// longer a PCG hash but a precomputed relaxed offset, looked up via `seed(ix, iy)` (a uniformArray closure
// built in the node). Offline/2D only (the relaxed set is periodic over the [0,P) bake tile); the live 3D
// field keeps the faithful blender-voronoi path. Structure mirrors blenderVoronoiDistanceToEdge, restricted
// to the k=0 plane (z is constant in the uv bake, so the ±1 z layers never win).
type V = MaterialValue;

// seed(ix, iy) → vec3 offset of the relaxed seed within cell (ix, iy), already periodic.
type SeedFn = (ix: V, iy: V) => V;

export function relaxedVoronoiDistanceToEdge(coord: V, seed: SeedFn): V {
  return Fn(() => {
    const cell = floor(coord) as V;
    const local = coord.sub(cell);
    const cx = int(cell.x);
    const cy = int(cell.y);
    const point = (i: number, j: number): V =>
      vec3(i, j, 0).add(seed(cx.add(i), cy.add(j))).sub(local);

    // pass 1: vector to the closest seed
    const vectorToClosest = vec3(0, 0, 0).toVar();
    const minDist = float(1e10).toVar();
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const vp = point(i, j);
        const d = vp.dot(vp);
        const closer = d.lessThan(minDist);
        minDist.assign(closer.select(d, minDist));
        vectorToClosest.assign(closer.select(vp, vectorToClosest));
      }

    // pass 2: min perpendicular distance to the edges against the closest seed
    const minEdge = float(1e10).toVar();
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const vp = point(i, j);
        const perp = vp.sub(vectorToClosest);
        const onEdge = perp.dot(perp).greaterThan(0.0001);
        const distanceToEdge = vectorToClosest.add(vp).div(2).dot(perp.normalize());
        minEdge.assign(onEdge.select(minEdge.min(distanceToEdge), minEdge));
      }
    return minEdge;
  })();
}

// value(ix, iy) → a per-cell value (e.g. a random tint) for the relaxed cell (ix, iy). Already periodic.
type ValueFn = (ix: V, iy: V) => V;

// Per-cell value lookup over the SAME relaxed point set as `relaxedVoronoiDistanceToEdge`: finds the cell
// whose seed is closest (pass 1 only) and returns `value(cellX, cellY)` for it. Used to give each mud plate
// a constant per-cell attribute (a random tint) that lines up exactly with the crack tessellation — a plain
// F1 Voronoi would use different (un-relaxed) seeds and its colour patches would cross the crack borders.
export function relaxedVoronoiCellValue(coord: V, seed: SeedFn, value: ValueFn): V {
  return Fn(() => {
    const cell = floor(coord) as V;
    const local = coord.sub(cell);
    const cx = int(cell.x);
    const cy = int(cell.y);
    const point = (i: number, j: number): V =>
      vec3(i, j, 0).add(seed(cx.add(i), cy.add(j))).sub(local);

    const minDist = float(1e10).toVar();
    const winX = int(0).toVar();
    const winY = int(0).toVar();
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const vp = point(i, j);
        const d = vp.dot(vp);
        const closer = d.lessThan(minDist);
        minDist.assign(closer.select(d, minDist));
        winX.assign(closer.select(cx.add(i), winX));
        winY.assign(closer.select(cy.add(j), winY));
      }
    return value(winX, winY);
  })();
}
