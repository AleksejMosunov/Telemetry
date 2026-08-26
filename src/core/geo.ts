/** Локальная плоская проекция вокруг опорной точки. Для трассы ~1 км ошибка ничтожна. */
export interface Projector { lat0: number; lon0: number; mPerLat: number; mPerLon: number; }

export function makeProjector(lat0: number, lon0: number): Projector {
  const rad = (lat0 * Math.PI) / 180;
  return {
    lat0, lon0,
    mPerLat: 111132.92 - 559.82 * Math.cos(2 * rad) + 1.175 * Math.cos(4 * rad),
    mPerLon: 111412.84 * Math.cos(rad) - 93.5 * Math.cos(3 * rad),
  };
}

export function project(p: Projector, lat: number, lon: number): [number, number] {
  return [(lon - p.lon0) * p.mPerLon, (lat - p.lat0) * p.mPerLat];
}

/** Фильтр Савицкого-Голея, порядок 2. Сглаживает, не заваливая пики. */
export function savGol(y: Float64Array, half: number): Float64Array {
  const n = y.length;
  const out = new Float64Array(n);
  const w = 2 * half + 1;
  // коэффициенты полинома 2-й степени методом наименьших квадратов
  let s0 = 0, s2 = 0, s4 = 0;
  for (let i = -half; i <= half; i++) { s0 += 1; s2 += i * i; s4 += i * i * i * i; }
  const det = s0 * s4 - s2 * s2;
  const c: number[] = [];
  for (let i = -half; i <= half; i++) c.push((s4 - s2 * i * i) / det);
  for (let k = 0; k < n; k++) {
    let acc = 0, wsum = 0;
    for (let j = -half; j <= half; j++) {
      const idx = k + j;
      if (idx < 0 || idx >= n) continue;
      acc += c[j + half] * y[idx];
      wsum += c[j + half];
    }
    out[k] = wsum !== 0 ? acc / wsum : y[k];
    if (k >= half && k < n - half) out[k] = acc;
  }
  return out;
}

/** То же, но для замкнутого контура (круг трассы) — без краевых эффектов. */
export function savGolCyclic(y: Float64Array, half: number): Float64Array {
  const n = y.length;
  const out = new Float64Array(n);
  let s0 = 0, s2 = 0, s4 = 0;
  for (let i = -half; i <= half; i++) { s0 += 1; s2 += i * i; s4 += i * i * i * i; }
  const det = s0 * s4 - s2 * s2;
  const c: number[] = [];
  for (let i = -half; i <= half; i++) c.push((s4 - s2 * i * i) / det);
  for (let k = 0; k < n; k++) {
    let acc = 0;
    for (let j = -half; j <= half; j++) acc += c[j + half] * y[(((k + j) % n) + n) % n];
    out[k] = acc;
  }
  return out;
}
