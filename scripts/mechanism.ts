import { readFileSync } from 'fs';
import { parseAimCsv, ch } from '../src/core/parse';
import { makeProjector, project, savGolCyclic } from '../src/core/geo';
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
const TA = lapsA.map(l => buildLapTrace(A, l, cl, grid));
const TB = lapsB.map(l => buildLapTrace(B, l, cl, grid));

const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
const sd = (x: number[]) => { const m = mean(x); return Math.sqrt(mean(x.map(v => (v - m) ** 2))); };

console.log('=== A. ИЗВИЛИСТОСТЬ ТРАЕКТОРИИ (по GPS, сглажено на 5 м — шум отфильтрован) ===');
for (const [name, T] of [['A', TA], ['B', TB]] as const) {
  const tv = T.map(t => {
    const sm = savGolCyclic(t.lat, 5);          // сглаживание ±5 м
    let acc = 0;
    for (let i = 1; i < sm.length; i++) acc += Math.abs(sm[i] - sm[i - 1]);
    return acc;
  });
  console.log(`  ${name}: суммарное боковое рыскание ${mean(tv).toFixed(1)} м/круг  (σ ${sd(tv).toFixed(2)})`);
}

console.log('\n=== B. КОРРЕКЦИИ РУЛЁМ (по гироскопу YawRate — GPS вообще не участвует) ===');
for (const [name, S, laps] of [['A', A, lapsA], ['B', B, lapsB]] as const) {
  const yr = ch(S, 'YawRate');
  const revs: number[] = [], jerk: number[] = [];
  for (const l of laps) {
    // сглаживаем гироскоп (окно 0.25 с), считаем смены знака производной = подруливания
    const n = l.i1 - l.i0;
    const y = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      let a = 0, c = 0;
      for (let j = -2; j <= 2; j++) { const i = l.i0 + k + j; if (i >= l.i0 && i < l.i1) { a += yr[i]; c++; } }
      y[k] = a / c;
    }
    let r = 0, j2 = 0;
    for (let k = 2; k < n; k++) {
      const d1 = y[k - 1] - y[k - 2], d2 = y[k] - y[k - 1];
      if (d1 * d2 < 0 && Math.abs(d2) > 3) r++;      // разворот скорости поворота
      j2 += (y[k] - 2 * y[k - 1] + y[k - 2]) ** 2;
    }
    revs.push(r); jerk.push(Math.sqrt(j2 / n));
  }
  console.log(`  ${name}: подруливаний ${mean(revs).toFixed(1)}/круг (σ ${sd(revs).toFixed(1)})   резкость руля ${mean(jerk).toFixed(2)} град/с²`);
}

console.log('\n=== C. СКОРОСТЬ НА ВЫХОДЕ ПО ВСЕМ КРУГАМ (медиана, км/ч) ===');
const medAt = (T: any[], s: number) => {
  const i = Math.round(s) % grid.length;
  const c = T.map((t: any) => t.v[i]).sort((a: number, b: number) => a - b);
  return c[c.length >> 1];
};
console.log('  пов.   апекс A/B          выход A/B         +30м после A/B');
let exitWorse = 0;
for (const c of corners) {
  const eA = medAt(TA, c.sEnd), eB = medAt(TB, c.sEnd);
  const pA = medAt(TA, c.sEnd + 30), pB = medAt(TB, c.sEnd + 30);
  const aA = medAt(TA, c.sApex), aB = medAt(TB, c.sApex);
  if (eB < eA) exitWorse++;
  console.log(`  ${c.name.padEnd(4)} ${aA.toFixed(1).padStart(5)}/${aB.toFixed(1).padStart(5)} (${(aB-aA>=0?'+':'')}${(aB-aA).toFixed(1)})   ` +
    `${eA.toFixed(1).padStart(5)}/${eB.toFixed(1).padStart(5)} (${(eB-eA>=0?'+':'')}${(eB-eA).toFixed(1)})   ` +
    `${pA.toFixed(1).padStart(5)}/${pB.toFixed(1).padStart(5)} (${(pB-pA>=0?'+':'')}${(pB-pA).toFixed(1)})`);
}
console.log(`  → B медленнее на выходе в ${exitWorse} из ${corners.length} поворотов`);

console.log('\n=== D. ИСПОЛЬЗОВАНИЕ СЦЕПЛЕНИЯ (круг трения, по GPS LatAcc/LonAcc) ===');
for (const [name, S, laps] of [['A', A, lapsA], ['B', B, lapsB]] as const) {
  const la = ch(S, 'GPS LatAcc'), lo = ch(S, 'GPS LonAcc');
  const peak: number[] = [], combo: number[] = [];
  for (const l of laps) {
    let mx = 0, cnt = 0, tot = 0;
    for (let i = l.i0; i < l.i1; i++) {
      const m = Math.hypot(la[i], lo[i]);
      if (m > mx) mx = m;
      // одновременный поворот+разгон/торможение = использование комбинированного сцепления
      if (Math.abs(la[i]) > 0.4 && Math.abs(lo[i]) > 0.25) cnt++;
      tot++;
    }
    peak.push(mx); combo.push(100 * cnt / tot);
  }
  console.log(`  ${name}: пик ускорения ${mean(peak).toFixed(2)} g   комбинированная нагрузка ${mean(combo).toFixed(1)}% времени круга`);
}
