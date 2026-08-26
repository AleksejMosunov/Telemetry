import { ch, type Session } from './parse';
import type { Centerline, Corner, Lap } from './track';
import { makeProjector, project } from './geo';
import { projectOntoCenterline, resampleByS } from './align';

export interface LapTrace {
  lap: Lap;
  t: Float64Array;      // время от старта круга, на сетке дистанции
  v: Float64Array;      // скорость, км/ч
  lat: Float64Array;    // боковое смещение от осевой, м
  pathLength: number;   // реально пройденная дистанция, м
}

/** Разбор круга: проекция на осевую + ресэмпл всех каналов на сетку дистанции. */
export function buildLapTrace(
  s: Session, lap: Lap, cl: Centerline, grid: Float64Array,
): LapTrace {
  const latC = ch(s, 'GPS Latitude'), lonC = ch(s, 'GPS Longitude');
  const spd = ch(s, 'GPS Speed'), tim = ch(s, 'Time');
  const n = lap.i1 - lap.i0;
  const xs = new Float64Array(n), ys = new Float64Array(n);
  const vv = new Float64Array(n), tt = new Float64Array(n);
  let pathLength = 0;
  for (let k = 0; k < n; k++) {
    const i = lap.i0 + k;
    const [x, y] = project(cl.proj, latC[i], lonC[i]);
    xs[k] = x; ys[k] = y; vv[k] = spd[i]; tt[k] = tim[i] - lap.tStart;
    if (k > 0) pathLength += Math.hypot(x - xs[k - 1], y - ys[k - 1]);
  }
  const pr = projectOntoCenterline(xs, ys, cl);
  return {
    lap,
    t: resampleByS(pr.s, tt, grid),
    v: resampleByS(pr.s, vv, grid),
    lat: resampleByS(pr.s, pr.lat, grid),
    pathLength,
  };
}

export interface Zone {
  corner: Corner;
  sStart: number; sEnd: number;   // от середины предыдущей прямой до середины следующей
}

/** Зоны покрывают круг целиком, поэтому потери по зонам суммируются точно в дельту круга. */
export function buildZones(corners: Corner[], length: number): Zone[] {
  const n = corners.length;
  return corners.map((c, i) => {
    const prev = corners[(i - 1 + n) % n];
    const next = corners[(i + 1) % n];
    let gapPrev = c.sStart - prev.sEnd; if (gapPrev < 0) gapPrev += length;
    let gapNext = next.sStart - c.sEnd; if (gapNext < 0) gapNext += length;
    return {
      corner: c,
      sStart: (c.sStart - gapPrev / 2 + length) % length,
      sEnd: (c.sEnd + gapNext / 2) % length,
    };
  });
}

export interface ZoneStats {
  zone: Zone;
  tZone: number;      // время в зоне, с
  vMin: number;       // апексная скорость, км/ч
  vEntry: number;     // скорость на входе в поворот
  vExit: number;      // скорость на выходе
  sBrake: number;     // точка начала замедления, м от начала круга
  latApex: number;    // боковое положение в апексе, м
}

/** Локальная скорость потери времени: производная накопленной дельты по дистанции.
 *  Показывает, ГДЕ время утекает, а не сколько накопилось к этой точке. */
export function deltaRate(t: Float64Array, tRef: Float64Array, win = 12): Float64Array {
  const n = t.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - win), b = Math.min(n - 1, i + win);
    out[i] = ((t[b] - tRef[b]) - (t[a] - tRef[a])) / (b - a);
  }
  return out;
}

const idxOf = (grid: Float64Array, s: number) =>
  Math.max(0, Math.min(grid.length - 1, Math.round(s / (grid[1] - grid[0]))));

export function zoneStats(tr: LapTrace, zones: Zone[], grid: Float64Array): ZoneStats[] {
  const N = grid.length;
  const nz = zones.length;
  const walk = (from: number, to: number, f: (i: number) => void) => {
    let i = from;
    for (;;) { f(i); if (i === to) break; i = (i + 1) % N; }
  };

  // Первый проход: низшая точка скорости в каждом повороте.
  const iMin: number[] = [], vMin: number[] = [];
  zones.forEach(z => {
    const ca = idxOf(grid, z.corner.sStart), cb = idxOf(grid, z.corner.sEnd);
    let best = Infinity, bi = ca;
    walk(ca, cb, i => { if (tr.v[i] < best) { best = tr.v[i]; bi = i; } });
    iMin.push(bi); vMin.push(best);
  });

  return zones.map((z, zi) => {
    const a = idxOf(grid, z.sStart), b = idxOf(grid, z.sEnd);
    const ca = idxOf(grid, z.corner.sStart), cb = idxOf(grid, z.corner.sEnd);
    const ap = idxOf(grid, z.corner.sApex);

    let tZone = tr.t[b] - tr.t[a];
    if (tZone < 0) tZone += tr.t[N - 1];

    // Точка замедления ищется от низшей точки ПРЕДЫДУЩЕГО поворота до низшей точки
    // этого — то есть по всей дуге «разогнался и затормозил». Границы зон тут не годятся:
    // пик скорости часто оказывается за несколько метров до начала зоны.
    const from = iMin[(zi - 1 + nz) % nz];
    let peak = -Infinity, iPeak = from;
    walk(from, iMin[zi], i => { if (tr.v[i] > peak) { peak = tr.v[i]; iPeak = i; } });

    // Прочерк ставится в двух честных случаях: поворот проходится без сброса скорости,
    // либо карт тормозит непрерывно ещё с предыдущего поворота и отдельной точки нет.
    const flatOut = peak - vMin[zi] < 2;
    const stillBraking = iPeak === from || iPeak === iMin[zi];

    return {
      zone: z, tZone, vMin: vMin[zi],
      vEntry: tr.v[ca], vExit: tr.v[cb],
      sBrake: flatOut || stillBraking ? NaN : grid[iPeak],
      latApex: tr.lat[ap],
    };
  });
}
