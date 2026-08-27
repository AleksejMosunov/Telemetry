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

export interface Sector {
  id: number;
  name: string;        // «S1»
  label: string;       // «T1–T3» — какие повороты внутри
  from: number; to: number;   // индексы зон, включительно
  sStart: number; sEnd: number;
  length: number;      // м
}

/**
 * Сектор — несколько подряд идущих зон.
 *
 * Как единица «идеального круга» он честнее отдельного поворота: быстрый вход
 * часто оплачивается выходом и следующим поворотом, и сумма лучших зон из разных
 * кругов складывает то, что в одном проезде несовместимо. Внутри сектора эта
 * сделка уже учтена, поэтому собранный из секторов круг реально достижим.
 *
 * Границы проводим по границам зон: они и так лежат на серединах прямых, где
 * карт идёт ровно, а значит время замера там устойчивее всего.
 */
function zoneLen(zones: Zone[], length: number, i: number) {
  const d = zones[i].sEnd - zones[i].sStart;
  return d < 0 ? d + length : d;
}

function makeSector(zones: Zone[], length: number, from: number, to: number, id: number): Sector {
  let len = 0;
  for (let k = from; k <= to; k++) len += zoneLen(zones, length, k);
  return {
    id, name: `S${id}`,
    label: from === to
      ? zones[from].corner.name
      : `${zones[from].corner.name}–${zones[to].corner.name}`,
    from, to,
    sStart: zones[from].sStart, sEnd: zones[to].sEnd,
    length: len,
  };
}

/** Кольцевое расстояние между точками круга, м. */
function ringDist(a: number, b: number, length: number) {
  const d = Math.abs(a - b) % length;
  return Math.min(d, length - d);
}

/**
 * Границы секторов, заданные вручную: доли длины круга [0..1).
 *
 * Каждую притягиваем к ближайшей границе зоны — сектор обязан состоять из целых
 * зон, иначе времена в нём нечем сложить, да и резать поворот пополам незачем.
 * Начало круга всегда граница, поэтому в cuts хранятся только внутренние.
 */
export function sectorsFromCuts(zones: Zone[], length: number, cuts: number[]): Sector[] {
  const nz = zones.length;
  const snapped = cuts.map(c => {
    const target = ((c % 1) + 1) % 1 * length;
    let best = 1, bestD = Infinity;
    for (let i = 1; i < nz; i++) {
      const d = ringDist(zones[i].sStart, target, length);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  });
  const starts = [0, ...new Set(snapped.filter(i => i > 0 && i < nz))].sort((p, q) => p - q);
  return starts.map((from, k) =>
    makeSector(zones, length, from, (starts[k + 1] ?? nz) - 1, k + 1));
}

/** Обратно: границы секторов в долях круга — в таком виде они и хранятся у трассы. */
export function cutsOfSectors(sectors: Sector[], zones: Zone[], length: number): number[] {
  return sectors.slice(1).map(s => zones[s.from].sStart / length);
}

export function buildSectors(zones: Zone[], length: number, perSector = 3.5): Sector[] {
  const nz = zones.length;
  const lenOf = (i: number) => {
    const d = zones[i].sEnd - zones[i].sStart;
    return d < 0 ? d + length : d;
  };
  const mk = (from: number, to: number, id: number) => makeSector(zones, length, from, to, id);

  if (nz < 4) return [mk(0, nz - 1, 1)];
  const k = Math.max(2, Math.min(5, Math.round(nz / perSector)));

  // границы — по долям длины круга, но обязательно по границе зоны
  const cum: number[] = [0];
  for (let i = 0; i < nz; i++) cum.push(cum[i] + lenOf(i));
  const total = cum[nz];

  const cuts: number[] = [0];
  for (let j = 1; j < k; j++) {
    const target = (j * total) / k;
    let best = cuts[cuts.length - 1] + 1;
    let bestD = Infinity;
    // граница не может совпасть с предыдущей и должна оставить место следующим
    for (let i = cuts[cuts.length - 1] + 1; i <= nz - (k - j); i++) {
      const d = Math.abs(cum[i] - target);
      if (d < bestD) { bestD = d; best = i; }
    }
    cuts.push(best);
  }
  cuts.push(nz);

  return Array.from({ length: k }, (_, j) => mk(cuts[j], cuts[j + 1] - 1, j + 1));
}

export interface ZoneStats {
  zone: Zone;
  tZone: number;      // время в зоне, с
  vMin: number;       // апексная скорость, км/ч
  vEntry: number;     // скорость на входе в поворот
  vExit: number;      // скорость на выходе
  sBrake: number;     // точка начала замедления, м от начала круга
  sMin: number;       // низшая точка скорости, м от начала круга — она же кольцо на карте
  sAccel: number;     // где после низшей точки скорость пошла вверх, м от начала круга
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

    // Начало разгона: где после низшей точки скорость устойчиво пошла вверх.
    // Порог в 1 км/ч отсекает дрожание на «полке» минимальной скорости — у карта
    // она нередко тянется на пару десятков метров, и голый argmin там случаен.
    let iAcc = -1;
    walk(iMin[zi], b, i => {
      if (iAcc >= 0 || tr.v[i] - vMin[zi] < 1) return;
      const j = (i + 5) % N;
      if (tr.v[j] > tr.v[i]) iAcc = i;
    });

    return {
      zone: z, tZone, vMin: vMin[zi],
      vEntry: tr.v[ca], vExit: tr.v[cb],
      sBrake: flatOut || stillBraking ? NaN : grid[iPeak],
      sMin: grid[iMin[zi]],
      sAccel: iAcc >= 0 ? grid[iAcc] : NaN,
      latApex: tr.lat[ap],
    };
  });
}
