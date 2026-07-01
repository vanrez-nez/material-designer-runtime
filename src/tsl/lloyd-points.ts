// Periodic (toroidal) Lloyd relaxation of a per-cell jittered point set, precomputed on the CPU for the
// offline Voronoi bake. Natural mud-crack cells are a centroidal Voronoi tessellation (CVT): equal-area,
// convex, no slivers and no squares. Plain jittered-grid Voronoi can't produce that (low jitter → squares,
// high jitter → clustered points → slivers), so we relax the seed set with Lloyd's algorithm first.
//
// The relaxation runs on a P×P torus so the result stays periodic (seamless) over the [0,P) bake tile.
// Output is, per integer cell (ix,iy), the relaxed seed OFFSET from the cell origin (absolutePos −(ix,iy)),
// flattened to vec3 (z=0). The shader indexes this by wrapped cell coords and uses the offset in place of
// the raw PCG hash — see relaxed-voronoi.ts.

// Deterministic per-cell jitter in [0,1)² (seeded). Any stable hash works; this set IS the source of truth
// once relaxed, so it need not match the GPU PCG hash.
function cellJitter(ix: number, iy: number, seed: number): [number, number] {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 362437)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  const a = (h & 0xffff) / 0x10000;
  h = Math.imul(h ^ (h >>> 16), 2246822519) >>> 0;
  const b = ((h >>> 8) & 0xffff) / 0x10000;
  return [a, b];
}

// Toroidal delta of `a − b` wrapped into (−P/2, P/2].
function torusDelta(a: number, b: number, P: number): number {
  let d = a - b;
  d -= P * Math.round(d / P);
  return d;
}

/**
 * Relaxed seed offsets for a P×P periodic Voronoi grid.
 * @param P            integer period (= round(scale)); tile spans [0,P) cells.
 * @param randomness   initial jitter amount (0..1), matches the Voronoi `randomness` look.
 * @param iterations   Lloyd iterations (0 = raw jitter, 2–4 = strongly relaxed/CVT).
 * @param seed         jitter seed.
 * @returns Float32Array of length P*P*3 — [ox,oy,0] per cell, index = iy*P + ix.
 */
export function relaxedCellOffsets(
  P: number,
  randomness: number,
  iterations: number,
  seed = 0,
): Float32Array {
  const N = P * P;
  const px = new Float64Array(N);
  const py = new Float64Array(N);
  for (let iy = 0; iy < P; iy++)
    for (let ix = 0; ix < P; ix++) {
      const [hx, hy] = cellJitter(ix, iy, seed);
      const idx = iy * P + ix;
      px[idx] = ix + 0.5 + (hx - 0.5) * randomness;
      py[idx] = iy + 0.5 + (hy - 0.5) * randomness;
    }

  // Lloyd: estimate each cell's centroid by sampling a fine grid over the torus, assigning each sample to
  // its nearest seed (searching the 3×3 neighbour cells is enough — seeds stay near cell centres), then
  // moving each seed to the mean of its samples.
  const M = Math.max(64, P * 24); // samples per axis
  for (let it = 0; it < iterations; it++) {
    const sumX = new Float64Array(N);
    const sumY = new Float64Array(N);
    const cnt = new Float64Array(N);
    for (let sy = 0; sy < M; sy++) {
      const wy = ((sy + 0.5) / M) * P;
      const cyi = Math.floor(wy);
      for (let sx = 0; sx < M; sx++) {
        const wx = ((sx + 0.5) / M) * P;
        const cxi = Math.floor(wx);
        let best = Infinity;
        let bi = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const ix = (((cxi + dx) % P) + P) % P;
            const iy = (((cyi + dy) % P) + P) % P;
            const idx = iy * P + ix;
            const ddx = torusDelta(px[idx], wx, P);
            const ddy = torusDelta(py[idx], wy, P);
            const d = ddx * ddx + ddy * ddy;
            if (d < best) {
              best = d;
              bi = idx;
            }
          }
        // accumulate the sample in the seed's local (unwrapped) frame so the mean is well-defined on the torus
        sumX[bi] += px[bi] + torusDelta(wx, px[bi], P);
        sumY[bi] += py[bi] + torusDelta(wy, py[bi], P);
        cnt[bi]++;
      }
    }
    for (let i = 0; i < N; i++) {
      if (cnt[i] > 0) {
        px[i] = (((sumX[i] / cnt[i]) % P) + P) % P;
        py[i] = (((sumY[i] / cnt[i]) % P) + P) % P;
      }
    }
  }

  const out = new Float32Array(N * 3);
  for (let iy = 0; iy < P; iy++)
    for (let ix = 0; ix < P; ix++) {
      const idx = iy * P + ix;
      // offset from this cell's origin, wrapped to (−P/2, P/2] so a seed that drifted across the tile edge
      // is expressed as a small offset near its original cell (the shader's ±1 search still finds it).
      let ox = px[idx] - ix;
      let oy = py[idx] - iy;
      ox -= P * Math.round(ox / P);
      oy -= P * Math.round(oy / P);
      out[idx * 3 + 0] = ox;
      out[idx * 3 + 1] = oy;
      out[idx * 3 + 2] = 0;
    }
  return out;
}
