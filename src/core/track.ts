import { ch, type Session } from './parse';
import { savGolCyclic, type Projector } from './geo';

export interface Lap {
  index: number;      // номер круга в сессии (1-based, полные круги)
  tStart: number; tEnd: number; time: number;
  i0: number; i1: number;   // индексы сэмплов [i0, i1)
  isOut: boolean; isIn: boolean;
}

/** Полные круги между соседними отсечками. Первый сегмент (старт записи -> первая
 *  отсечка) выбрасываем, последний помечаем как заездной. */
export function splitLaps(s: Session): Lap[] {
  const t = ch(s, 'Time');
  const b = s.beacons;
  const laps: Lap[] = [];
  const findIdx = (time: number) => {
    let lo = 0, hi = t.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < time) lo = m + 1; else hi = m; }
    return lo;
  };
  for (let k = 0; k + 1 < b.length; k++) {
    laps.push({
      index: k + 1,
      tStart: b[k], tEnd: b[k + 1], time: b[k + 1] - b[k],
      i0: findIdx(b[k]), i1: findIdx(b[k + 1]),
      isOut: false, isIn: k + 2 === b.length,
    });
  }
  return laps;
}

/** Медианное время круга по «чистым» кругам (без заездного и выбросов). */
export function cleanLaps(laps: Lap[], tolerance = 1.06): Lap[] {
  const full = laps.filter(l => !l.isIn && !l.isOut);
  if (!full.length) return full;
  const sorted = [...full].map(l => l.time).sort((a, b) => a - b);
  const best = sorted[0];
  return full.filter(l => l.time <= best * tolerance);
}

export interface Centerline {
  proj: Projector;
  x: Float64Array; y: Float64Array;   // равномерно по дуге, шаг step
  curv: Float64Array;                 // кривизна 1/м, знак = сторона поворота
  heading: Float64Array;
  length: number; step: number; n: number;
}

/** Опорная осевая линия трассы из одного круга: ресэмпл по дуге + циклическое сглаживание. */
export function buildCenterline(
  xs: number[], ys: number[], proj: Projector, step = 1.0, smoothM = 6,
): Centerline {
  // накопленная дуга по исходным точкам, с замыканием
  const px = [...xs], py = [...ys];
  const m = px.length;
  const d: number[] = [0];
  for (let i = 1; i < m; i++) d.push(d[i - 1] + Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1]));
  const closeSeg = Math.hypot(px[0] - px[m - 1], py[0] - py[m - 1]);
  const total = d[m - 1] + closeSeg;

  const n = Math.max(16, Math.round(total / step));
  const realStep = total / n;
  const rx = new Float64Array(n), ry = new Float64Array(n);
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const target = i * realStep;
    while (seg < m - 1 && d[seg + 1] < target) seg++;
    if (seg >= m - 1) {
      const f = (target - d[m - 1]) / closeSeg;
      rx[i] = px[m - 1] + (px[0] - px[m - 1]) * f;
      ry[i] = py[m - 1] + (py[0] - py[m - 1]) * f;
    } else {
      const segLen = d[seg + 1] - d[seg] || 1e-9;
      const f = (target - d[seg]) / segLen;
      rx[i] = px[seg] + (px[seg + 1] - px[seg]) * f;
      ry[i] = py[seg] + (py[seg + 1] - py[seg]) * f;
    }
  }

  const half = Math.max(1, Math.round(smoothM / realStep));
  const sx = savGolCyclic(rx, half), sy = savGolCyclic(ry, half);

  // курс и кривизна по центральным разностям на равномерной сетке
  const heading = new Float64Array(n), curv = new Float64Array(n);
  const at = (i: number) => ((i % n) + n) % n;
  for (let i = 0; i < n; i++) {
    heading[i] = Math.atan2(sy[at(i + 1)] - sy[at(i - 1)], sx[at(i + 1)] - sx[at(i - 1)]);
  }
  for (let i = 0; i < n; i++) {
    let dth = heading[at(i + 1)] - heading[at(i - 1)];
    while (dth > Math.PI) dth -= 2 * Math.PI;
    while (dth < -Math.PI) dth += 2 * Math.PI;
    curv[i] = dth / (2 * realStep);
  }
  const curvS = savGolCyclic(curv, Math.max(1, Math.round(4 / realStep)));

  return { proj, x: sx, y: sy, curv: curvS, heading, length: total, step: realStep, n };
}

export interface Corner {
  id: number; name: string;
  sStart: number; sApex: number; sEnd: number;
  dir: 'L' | 'R';
  radius: number;      // минимальный радиус, м
}

/** Нарезка поворотов по кривизне осевой линии — свойство трассы, не пилота. */
export function detectCorners(cl: Centerline, minCurv = 0.018, minLenM = 10, gapM = 12): Corner[] {
  const n = cl.n, st = cl.step;
  const active = new Uint8Array(n);
  for (let i = 0; i < n; i++) active[i] = Math.abs(cl.curv[i]) > minCurv ? 1 : 0;

  // собираем непрерывные участки по кольцу
  const runs: Array<[number, number]> = [];
  let i = 0;
  while (i < n && active[i]) i++;         // старт вне поворота
  if (i === n) return [];
  const start0 = i;
  let cur = -1;
  for (let k = 0; k < n; k++) {
    const idx = (start0 + k) % n;
    if (active[idx]) { if (cur < 0) cur = k; }
    else if (cur >= 0) { runs.push([cur, k - 1]); cur = -1; }
  }
  if (cur >= 0) runs.push([cur, n - 1]);

  // склеиваем близкие участки одного знака
  const merged: Array<[number, number]> = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last) {
      const gap = (r[0] - last[1]) * st;
      const s1 = Math.sign(cl.curv[(start0 + last[1]) % n]);
      const s2 = Math.sign(cl.curv[(start0 + r[0]) % n]);
      if (gap < gapM && s1 === s2) { last[1] = r[1]; continue; }
    }
    merged.push([r[0], r[1]]);
  }

  const corners: Corner[] = [];
  for (const [a, b] of merged) {
    if ((b - a + 1) * st < minLenM) continue;
    let apex = a, best = 0;
    for (let k = a; k <= b; k++) {
      const c = Math.abs(cl.curv[(start0 + k) % n]);
      if (c > best) { best = c; apex = k; }
    }
    const sOf = (k: number) => (((start0 + k) % n) * st);
    corners.push({
      id: 0, name: '',
      sStart: sOf(a), sApex: sOf(apex), sEnd: sOf(b),
      dir: cl.curv[(start0 + apex) % n] > 0 ? 'L' : 'R',
      radius: 1 / best,
    });
  }
  corners.sort((p, q) => p.sStart - q.sStart);
  corners.forEach((c, k) => { c.id = k + 1; c.name = `T${k + 1}`; });
  return corners;
}
