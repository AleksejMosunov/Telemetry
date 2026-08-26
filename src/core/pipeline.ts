import { parseAimCsv, ch, type Session } from './parse';
import { makeProjector, project } from './geo';
import { splitLaps, cleanLaps, buildCenterline, detectCorners, type Corner, type Lap } from './track';
import { makeGrid } from './align';
import { zonePathLengths } from './geometry';
import { buildLapTrace, buildZones, zoneStats, type Zone, type ZoneStats } from './analysis';

export interface LapInfo {
  index: number; time: number; clean: boolean; isIn: boolean;
  pathLength: number; corrections: number;
}

export interface DriverStats {
  best: number; median: number; sd: number;
  medianPath: number; pathSd: number;
  firstHalf: number; secondHalf: number; drift: number;
  peakG: number; comboPct: number;
  medianCorrections: number;
}

export interface DriverResult {
  id: string; name: string; fileName: string;
  /** Устойчивый ключ заезда — по нему запоминается заданное пользователем имя пилота. */
  fingerprint: string;
  meta: Record<string, string>;
  laps: LapInfo[];
  cleanIdx: number[];        // индексы в laps
  bestIdx: number;
  stats: DriverStats;
  /** траектории чистых кругов на общей сетке дистанции */
  traces: { lapIndex: number; v: Float64Array; lat: Float64Array; t: Float64Array }[];
  medV: Float64Array; medT: Float64Array; medLat: Float64Array;
  /** разброс траектории по кругам, м (СКО на каждом метре) */
  medLatSd: Float64Array;
  /** длина усреднённой траектории, м — считается по реальным кругам, а не по сглаженной линии */
  medPathByZone: Float64Array;
  bestPathByZone: Float64Array;
  bestV: Float64Array; bestT: Float64Array; bestLat: Float64Array;
  zoneMed: ZoneStats[]; zoneBest: ZoneStats[];
  /** [круг][зона] — время в зоне, для тепловой карты стабильности */
  zoneByLap: Float64Array[];
}

export interface Analysis {
  track: { x: Float64Array; y: Float64Array; curv: Float64Array; length: number; step: number; n: number };
  corners: Corner[];
  zones: Zone[];
  grid: Float64Array;
  drivers: DriverResult[];
  warnings: string[];
}

/** "3:31 PM" -> "15:31" */
export function time24(v: string | undefined): string {
  if (!v) return '';
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(v.trim());
  if (!m) return v;
  let h = Number(m[1]);
  const ap = m[3]?.toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

const PALETTE = ['#4dabf7', '#ff922b', '#51cf66', '#e599f7', '#ffd43b', '#ff6b6b'];
export const driverColor = (i: number) => PALETTE[i % PALETTE.length];

const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const sdev = (a: number[]) => { const m = avg(a); return Math.sqrt(avg(a.map(v => (v - m) ** 2))); };

/** Подруливания за круг по гироскопу: смены знака производной скорости рыскания. */
function corrections(s: Session, lap: Lap): number {
  let yr: Float64Array;
  try { yr = ch(s, 'YawRate'); } catch { return NaN; }
  const n = lap.i1 - lap.i0;
  if (n < 8) return NaN;
  const y = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let a = 0, c = 0;
    for (let j = -2; j <= 2; j++) { const i = lap.i0 + k + j; if (i >= lap.i0 && i < lap.i1) { a += yr[i]; c++; } }
    y[k] = a / c;
  }
  let r = 0;
  for (let k = 2; k < n; k++) {
    const d1 = y[k - 1] - y[k - 2], d2 = y[k] - y[k - 1];
    if (d1 * d2 < 0 && Math.abs(d2) > 3) r++;
  }
  return r;
}

function gripUsage(s: Session, laps: Lap[]): { peakG: number; comboPct: number } {
  let la: Float64Array, lo: Float64Array;
  try { la = ch(s, 'GPS LatAcc'); lo = ch(s, 'GPS LonAcc'); }
  catch { return { peakG: NaN, comboPct: NaN }; }
  const peaks: number[] = [], combos: number[] = [];
  for (const l of laps) {
    let mx = 0, cnt = 0, tot = 0;
    for (let i = l.i0; i < l.i1; i++) {
      const m = Math.hypot(la[i], lo[i]);
      if (m > mx) mx = m;
      if (Math.abs(la[i]) > 0.4 && Math.abs(lo[i]) > 0.25) cnt++;
      tot++;
    }
    peaks.push(mx); combos.push(tot ? (100 * cnt) / tot : 0);
  }
  return { peakG: avg(peaks), comboPct: avg(combos) };
}

/** Медианный круг: медиана приращения времени на каждом метре, затем накопление.
 *  Устойчивее, чем медиана накопленного времени. */
function medianTimeTrace(traces: { t: Float64Array }[], N: number): Float64Array {
  const out = new Float64Array(N);
  const buf = new Array(traces.length);
  for (let i = 1; i < N; i++) {
    for (let k = 0; k < traces.length; k++) buf[k] = traces[k].t[i] - traces[k].t[i - 1];
    out[i] = out[i - 1] + med(buf);
  }
  return out;
}

function spread(traces: Float64Array[], N: number): Float64Array {
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let m = 0;
    for (const t of traces) m += t[i];
    m /= traces.length || 1;
    let v = 0;
    for (const t of traces) v += (t[i] - m) ** 2;
    out[i] = Math.sqrt(v / (traces.length || 1));
  }
  return out;
}

function medianChannel(traces: Float64Array[], N: number): Float64Array {
  const out = new Float64Array(N);
  const buf = new Array(traces.length);
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < traces.length; k++) buf[k] = traces[k][i];
    out[i] = med(buf);
  }
  return out;
}

export function analyze(files: { name: string; text: string }[]): Analysis {
  const warnings: string[] = [];
  const parsed = files.map(f => {
    const s = parseAimCsv(f.text, f.name);
    const laps = splitLaps(s);
    const clean = cleanLaps(laps);
    if (!clean.length) throw new Error(`${f.name}: не найдено ни одного полного круга`);
    return { file: f, s, laps, clean };
  });

  // все заезды должны быть на одной трассе
  const centroid = (p: typeof parsed[0]) => {
    const la = ch(p.s, 'GPS Latitude'), lo = ch(p.s, 'GPS Longitude');
    let sa = 0, so = 0;
    for (let i = 0; i < p.s.n; i += 20) { sa += la[i]; so += lo[i]; }
    const k = Math.ceil(p.s.n / 20);
    return [sa / k, so / k] as const;
  };
  const c0 = centroid(parsed[0]);
  for (const p of parsed.slice(1)) {
    const c = centroid(p);
    const km = Math.hypot((c[0] - c0[0]) * 111, (c[1] - c0[1]) * 111 * Math.cos((c0[0] * Math.PI) / 180));
    if (km > 2) warnings.push(`${p.file.name}: похоже, это другая трасса (${km.toFixed(1)} км от первой) — сравнение некорректно`);
  }

  // осевая линия строится по абсолютно лучшему кругу среди всех заездов
  let refP = parsed[0], refLap = parsed[0].clean[0];
  for (const p of parsed) for (const l of p.clean) if (l.time < refLap.time) { refP = p; refLap = l; }
  const latR = ch(refP.s, 'GPS Latitude'), lonR = ch(refP.s, 'GPS Longitude');
  const proj = makeProjector(latR[refLap.i0], lonR[refLap.i0]);
  const rx: number[] = [], ry: number[] = [];
  for (let i = refLap.i0; i < refLap.i1; i++) {
    const [x, y] = project(proj, latR[i], lonR[i]); rx.push(x); ry.push(y);
  }
  const cl = buildCenterline(rx, ry, proj, 1.0, 6);
  const grid = makeGrid(cl.length, 1.0);
  const corners = detectCorners(cl);
  const zones = buildZones(corners, cl.length);
  if (!corners.length) warnings.push('Повороты не распознаны — проверьте качество GPS');

  const drivers: DriverResult[] = parsed.map((p, di) => {
    const cleanSet = new Set(p.clean.map(l => l.index));
    const lapInfos: LapInfo[] = [];
    const traces: DriverResult['traces'] = [];
    const zoneByLap: Float64Array[] = [];

    for (const l of p.laps) {
      const isClean = cleanSet.has(l.index);
      const tr = buildLapTrace(p.s, l, cl, grid);
      lapInfos.push({
        index: l.index, time: l.time, clean: isClean, isIn: l.isIn,
        pathLength: tr.pathLength, corrections: corrections(p.s, l),
      });
      if (isClean) {
        traces.push({ lapIndex: l.index, v: tr.v, lat: tr.lat, t: tr.t });
        const zs = zoneStats(tr, zones, grid);
        zoneByLap.push(Float64Array.from(zs.map(z => z.tZone)));
      }
    }

    const cleanInfos = lapInfos.filter(l => l.clean);
    const times = cleanInfos.map(l => l.time);
    const half = Math.floor(cleanInfos.length / 2);
    const grip = gripUsage(p.s, p.clean);
    const fh = avg(times.slice(0, half)), sh = avg(times.slice(half));

    const N = grid.length;
    const medT = medianTimeTrace(traces, N);
    const medV = medianChannel(traces.map(t => t.v), N);
    const medLat = medianChannel(traces.map(t => t.lat), N);

    const bestLapIndex = cleanInfos.reduce((a, b) => (a.time <= b.time ? a : b)).index;
    const bi = traces.findIndex(t => t.lapIndex === bestLapIndex);
    const bestTrace = traces[bi];
    const bestLap = p.laps.find(l => l.index === bestLapIndex)!;
    const bestFull = buildLapTrace(p.s, bestLap, cl, grid);

    const medLatSd = spread(traces.map(t => t.lat), N);

    // Усреднённый круг — синтетический: медиана по каждому метру.
    // Раньше зоны считались по одному «представительному» реальному кругу,
    // из-за чего таблица поворотов расходилась с графиками.
    const medTrace = { lap: bestLap, t: medT, v: medV, lat: medLat, pathLength: 0 };

    // Длину траектории в зоне усредняем по РЕАЛЬНЫМ кругам: усреднение самой линии
    // сглаживает рыскание, а именно оно и даёт лишние метры.
    const zonePathPerLap = traces.map(tr => zonePathLengths(cl, tr.lat, zones, grid));
    const medPathByZone = new Float64Array(zones.length);
    for (let z = 0; z < zones.length; z++) medPathByZone[z] = med(zonePathPerLap.map(r => r[z]));
    const bestPathByZone = zonePathLengths(cl, bestFull.lat, zones, grid);

    return {
      id: `d${di}`,
      fingerprint: [p.s.meta['Racer'], p.s.meta['Date'], p.s.meta['Time'],
        p.s.meta['Duration'], p.s.meta['Vehicle']].filter(Boolean).join('|'),
      name: p.s.meta['Racer'] && parsed.length > 1
        ? `${p.s.meta['Racer']} · ${time24(p.s.meta['Time']) || p.file.name}`
        : (p.s.meta['Racer'] || p.file.name),
      fileName: p.file.name,
      meta: p.s.meta,
      laps: lapInfos,
      cleanIdx: lapInfos.map((l, i) => (l.clean ? i : -1)).filter(i => i >= 0),
      bestIdx: lapInfos.findIndex(l => l.index === bestLapIndex),
      stats: {
        best: Math.min(...times), median: med(times), sd: sdev(times),
        medianPath: med(cleanInfos.map(l => l.pathLength)),
        pathSd: sdev(cleanInfos.map(l => l.pathLength)),
        firstHalf: fh, secondHalf: sh, drift: sh - fh,
        peakG: grip.peakG, comboPct: grip.comboPct,
        medianCorrections: med(cleanInfos.map(l => l.corrections).filter(v => !isNaN(v))),
      },
      traces,
      medV, medT, medLat,
      bestV: bestTrace.v, bestT: bestTrace.t, bestLat: bestTrace.lat,
      medLatSd, medPathByZone, bestPathByZone,
      zoneMed: zoneStats(medTrace, zones, grid),
      zoneBest: zoneStats(bestFull, zones, grid),
      zoneByLap,
    };
  });

  return {
    track: { x: cl.x, y: cl.y, curv: cl.curv, length: cl.length, step: cl.step, n: cl.n },
    corners, zones, grid, drivers, warnings,
  };
}
