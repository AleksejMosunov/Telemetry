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

const idxOf = (grid: Float64Array, s: number) =>
  Math.max(0, Math.min(grid.length - 1, Math.round(s / (grid[1] - grid[0]))));

export function zoneStats(tr: LapTrace, zones: Zone[], grid: Float64Array): ZoneStats[] {
  const N = grid.length;
  return zones.map(z => {
    const a = idxOf(grid, z.sStart), b = idxOf(grid, z.sEnd);
    const ca = idxOf(grid, z.corner.sStart), cb = idxOf(grid, z.corner.sEnd);
    const ap = idxOf(grid, z.corner.sApex);
    const walk = (from: number, to: number, f: (i: number) => void) => {
      let i = from;
      for (;;) { f(i); if (i === to) break; i = (i + 1) % N; }
    };
    let tZone = tr.t[b] - tr.t[a]; if (tZone < 0) tZone += tr.t[N - 1];
    let vMin = Infinity, iMin = ca;
    walk(ca, cb, i => { if (tr.v[i] < vMin) { vMin = tr.v[i]; iMin = i; } });
    // начало торможения: последний максимум скорости перед апексом внутри зоны
    let vPeak = -1, iPeak = a;
    walk(a, iMin, i => { if (tr.v[i] >= vPeak) { vPeak = tr.v[i]; iPeak = i; } });
    return {
      zone: z, tZone, vMin,
      vEntry: tr.v[ca], vExit: tr.v[cb],
      sBrake: grid[iPeak], latApex: tr.lat[ap],
    };
  });
}
