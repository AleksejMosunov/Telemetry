import type { Centerline } from './track';

export interface Projected {
  s: Float64Array;    // дистанция вдоль осевой линии, м (монотонно 0..L)
  lat: Float64Array;  // боковое смещение от осевой, м (+ влево)
}

/** Проекция траектории круга на осевую линию трассы.
 *  Именно это позволяет сравнивать пилотов «в одной точке трассы»,
 *  а не «на одной пройденной дистанции» — они ездят разными линиями. */
export function projectOntoCenterline(
  xs: Float64Array, ys: Float64Array, cl: Centerline,
): Projected {
  const n = xs.length, m = cl.n, L = cl.length;
  const s = new Float64Array(n), lat = new Float64Array(n);

  const nearestIdx = (x: number, y: number, from: number, span: number) => {
    let bi = from, bd = Infinity;
    for (let k = -span; k <= span; k++) {
      const i = ((from + k) % m + m) % m;
      const d = (cl.x[i] - x) ** 2 + (cl.y[i] - y) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  };

  // первую точку ищем по всей линии, дальше — в окне
  let idx = nearestIdx(xs[0], ys[0], 0, m >> 1);
  let raw = 0, prevRaw = 0, unwrapped = 0;

  for (let k = 0; k < n; k++) {
    idx = nearestIdx(xs[k], ys[k], idx, 30);
    // уточняем внутри сегмента [idx, idx+1]
    const j = (idx + 1) % m;
    const ax = cl.x[idx], ay = cl.y[idx];
    const bx = cl.x[j], by = cl.y[j];
    const ex = bx - ax, ey = by - ay;
    const len2 = ex * ex + ey * ey || 1e-9;
    let t = ((xs[k] - ax) * ex + (ys[k] - ay) * ey) / len2;
    t = Math.max(-0.5, Math.min(1.5, t));
    raw = (idx + t) * cl.step;
    // боковое смещение — знаковое векторное произведение
    const nx = -ey, ny = ex;
    const inv = 1 / Math.sqrt(len2);
    lat[k] = ((xs[k] - ax) * nx + (ys[k] - ay) * ny) * inv;

    if (k === 0) { unwrapped = raw; }
    else {
      let d = raw - prevRaw;
      if (d > L / 2) d -= L;
      if (d < -L / 2) d += L;
      unwrapped += d;
    }
    prevRaw = raw;
    s[k] = unwrapped;
  }
  // приводим старт круга к нулю
  const off = s[0];
  for (let k = 0; k < n; k++) s[k] -= off;
  return { s, lat };
}

/** Линейная интерполяция канала на равномерную сетку дистанции.
 *  s должна быть неубывающей — принудительно выпрямляем микро-откаты. */
export function resampleByS(
  s: Float64Array, v: Float64Array, grid: Float64Array,
): Float64Array {
  const n = s.length;
  const sm = new Float64Array(n);
  sm[0] = s[0];
  for (let i = 1; i < n; i++) sm[i] = Math.max(sm[i - 1] + 1e-6, s[i]);

  const out = new Float64Array(grid.length);
  let j = 0;
  for (let g = 0; g < grid.length; g++) {
    const t = grid[g];
    while (j < n - 2 && sm[j + 1] < t) j++;
    const f = (t - sm[j]) / (sm[j + 1] - sm[j]);
    out[g] = v[j] + (v[j + 1] - v[j]) * Math.max(0, Math.min(1, f));
  }
  return out;
}

export function makeGrid(length: number, step: number): Float64Array {
  const n = Math.floor(length / step);
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) g[i] = i * step;
  return g;
}
