import { readFileSync } from 'fs';
import { parseAimCsv, ch } from '../src/core/parse';
import { makeProjector, project } from '../src/core/geo';
import { splitLaps, cleanLaps, buildCenterline, detectCorners } from '../src/core/track';
import { makeGrid } from '../src/core/align';
import { buildLapTrace, buildZones } from '../src/core/analysis';

const DIR = '/Users/macbook/Documents/karting/telemetry/csv';
const A = parseAimCsv(readFileSync(`${DIR}/1.csv`, 'utf8'), 'A');
const B = parseAimCsv(readFileSync(`${DIR}/2.csv`, 'utf8'), 'B');
const lapsA = cleanLaps(splitLaps(A)), lapsB = cleanLaps(splitLaps(B));
const bestA = lapsA.reduce((a, b) => (a.time <= b.time ? a : b));

const latA = ch(A, 'GPS Latitude'), lonA = ch(A, 'GPS Longitude');
const proj = makeProjector(latA[bestA.i0], lonA[bestA.i0]);
const bx: number[] = [], by: number[] = [];
for (let i = bestA.i0; i < bestA.i1; i++) { const [x, y] = project(proj, latA[i], lonA[i]); bx.push(x); by.push(y); }
const cl = buildCenterline(bx, by, proj, 1.0, 6);
const grid = makeGrid(cl.length, 1.0);
const corners = detectCorners(cl);
const zones = buildZones(corners, cl.length);

const trAll = (s: any, laps: any[]) => laps.map(l => buildLapTrace(s, l, cl, grid));
const TA = trAll(A, lapsA), TB = trAll(B, lapsB);

const stat = (xs: number[]) => {
  const v = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { mean, sd, med: v[v.length >> 1], min: v[0], max: v[v.length - 1] };
};

console.log('=== ПРОВЕРКА 1: длина траектории по ВСЕМ кругам ===');
for (const [name, T] of [['A', TA], ['B', TB]] as const) {
  const st = stat(T.map(t => t.pathLength));
  console.log(`  ${name}: среднее ${st.mean.toFixed(1)} м  медиана ${st.med.toFixed(1)}  σ ${st.sd.toFixed(2)}  диапазон ${st.min.toFixed(1)}..${st.max.toFixed(1)}  (n=${T.length})`);
}

console.log('\n=== ПРОВЕРКА 2: шум GPS (дрожание позиции на прямой) ===');
// на прямой боковое смещение должно меняться плавно; берём СКО второй разности
for (const [name, S, laps] of [['A', A, lapsA], ['B', B, lapsB]] as const) {
  const la = ch(S, 'GPS Latitude'), lo = ch(S, 'GPS Longitude');
  let acc = 0, cnt = 0;
  for (const l of laps) {
    for (let i = l.i0 + 2; i < l.i1; i++) {
      const [x0, y0] = project(proj, la[i - 2], lo[i - 2]);
      const [x1, y1] = project(proj, la[i - 1], lo[i - 1]);
      const [x2, y2] = project(proj, la[i], lo[i]);
      const jx = x2 - 2 * x1 + x0, jy = y2 - 2 * y1 + y0;
      acc += jx * jx + jy * jy; cnt++;
    }
  }
  console.log(`  ${name}: СКО дрожания ${Math.sqrt(acc / cnt).toFixed(4)} м/сэмпл²`);
}

console.log('\n=== ПРОВЕРКА 3: среднее боковое смещение от осевой по поворотам ===');
console.log('  (+ = левее осевой; сравниваем ГДЕ едут, это к шуму не чувствительно)');
const meanLatAt = (T: any[], s: number) => {
  const i = Math.round(s); let a = 0;
  for (const t of T) a += t.lat[i];
  return a / T.length;
};
console.log('  пов.  вход A / B        апекс A / B       выход A / B');
for (const c of corners) {
  const f = (s: number) => `${meanLatAt(TA, s).toFixed(2).padStart(6)} /${meanLatAt(TB, s).toFixed(2).padStart(6)}`;
  console.log(`  ${c.name.padEnd(4)} ${f(c.sStart)}   ${f(c.sApex)}   ${f(c.sEnd)}`);
}

console.log('\n=== ПРОВЕРКА 4: стабильность и ход стинта ===');
for (const [name, laps] of [['A', lapsA], ['B', lapsB]] as const) {
  const st = stat(laps.map(l => l.time));
  const half = Math.floor(laps.length / 2);
  const h1 = stat(laps.slice(0, half).map(l => l.time)).mean;
  const h2 = stat(laps.slice(half).map(l => l.time)).mean;
  console.log(`  ${name}: лучший ${st.min.toFixed(3)}  медиана ${st.med.toFixed(3)}  σ ${st.sd.toFixed(3)}  | 1-я половина ${h1.toFixed(3)} → 2-я ${h2.toFixed(3)} (${(h2-h1>=0?'+':'')}${(h2-h1).toFixed(3)})`);
}

console.log('\n=== ПРОВЕРКА 5: медианный круг вместо лучшего (устойчивее к разовой удаче) ===');
const medTrace = (T: any[]) => {
  const N = grid.length, out = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const col = T.map(t => t.v[i]).sort((a, b) => a - b);
    out[i] = col[col.length >> 1];
  }
  return out;
};
const vA = medTrace(TA), vB = medTrace(TB);
let worse = 0, better = 0;
for (let i = 0; i < grid.length; i++) (vB[i] < vA[i] ? worse++ : better++);
console.log(`  по медианной скорости B медленнее на ${(100*worse/grid.length).toFixed(0)}% длины круга, быстрее на ${(100*better/grid.length).toFixed(0)}%`);
