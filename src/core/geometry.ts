import type { Centerline } from './track';
import type { Zone } from './analysis';

/** Нормаль к осевой линии в узле i. Знак согласован с проекцией в align.ts. */
export function normalAt(cl: { x: Float64Array; y: Float64Array; n: number }, i: number): [number, number] {
  const n = cl.n;
  const j = (i + 1) % n, k = (i - 1 + n) % n;
  const ex = cl.x[j] - cl.x[k], ey = cl.y[j] - cl.y[k];
  const L = Math.hypot(ex, ey) || 1;
  return [-ey / L, ex / L];
}

/** Реально пройденная длина внутри каждой зоны, м. */
export function zonePathLengths(
  cl: Centerline, lat: Float64Array, zones: Zone[], grid: Float64Array,
): Float64Array {
  const n = cl.n;
  const pt = (i: number): [number, number] => {
    const [nx, ny] = normalAt(cl, i);
    const off = lat[Math.min(i, lat.length - 1)] || 0;
    return [cl.x[i] + nx * off, cl.y[i] + ny * off];
  };
  const out = new Float64Array(zones.length);
  zones.forEach((z, k) => {
    const a = Math.round(z.sStart) % n, b = Math.round(z.sEnd) % n;
    let L = 0, prev = pt(a), i = a;
    for (let guard = 0; guard <= n; guard++) {
      if (i === b) break;
      i = (i + 1) % n;
      const cur = pt(i);
      L += Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
      prev = cur;
    }
    out[k] = L;
  });
  return out;
}
