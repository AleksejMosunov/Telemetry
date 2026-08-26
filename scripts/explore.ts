import { readFileSync } from 'fs';
import { parseAimCsv, ch } from '../src/core/parse';
import { makeProjector, project } from '../src/core/geo';
import { splitLaps, cleanLaps, buildCenterline, detectCorners } from '../src/core/track';
import { projectOntoCenterline, resampleByS, makeGrid } from '../src/core/align';

const DIR = '/Users/macbook/Documents/karting/telemetry/csv';
const files = ['1.csv', '2.csv'];

const sessions = files.map(f => parseAimCsv(readFileSync(`${DIR}/${f}`, 'utf8'), f));

for (const s of sessions) {
  const laps = splitLaps(s);
  const clean = cleanLaps(laps);
  const times = clean.map(l => l.time).sort((a, b) => a - b);
  const med = times[Math.floor(times.length / 2)];
  console.log(`\n=== ${s.sourceName} | ${s.meta['Time']} | ${s.n} сэмплов @ ${s.sampleRate}Гц`);
  console.log(`  кругов всего ${laps.length}, чистых ${clean.length}`);
  console.log(`  лучший ${times[0].toFixed(3)}  медиана ${med.toFixed(3)}  худший ${times[times.length-1].toFixed(3)}`);
  const sat = ch(s, 'GPS Nsat'), acc = ch(s, 'GPS PosAccuracy');
  let minSat = 99, maxAcc = 0;
  for (let i = 0; i < s.n; i++) { minSat = Math.min(minSat, sat[i]); maxAcc = Math.max(maxAcc, acc[i]); }
  console.log(`  GPS: спутников мин ${minSat}, точность худшая ${maxAcc.toFixed(1)} мм`);
}

// --- опорная трасса из лучшего круга первой сессии ---
const s1 = sessions[0];
const laps1 = splitLaps(s1);
const best1 = cleanLaps(laps1).reduce((a, b) => (a.time <= b.time ? a : b));
const lat1 = ch(s1, 'GPS Latitude'), lon1 = ch(s1, 'GPS Longitude');
const proj = makeProjector(lat1[best1.i0], lon1[best1.i0]);

const bx: number[] = [], by: number[] = [];
for (let i = best1.i0; i < best1.i1; i++) {
  const [x, y] = project(proj, lat1[i], lon1[i]);
  bx.push(x); by.push(y);
}
const cl = buildCenterline(bx, by, proj, 1.0, 6);
console.log(`\n=== ОСЕВАЯ ЛИНИЯ ===`);
console.log(`  длина круга ${cl.length.toFixed(1)} м, узлов ${cl.n}, шаг ${cl.step.toFixed(3)} м`);
let kmax = 0; for (let i = 0; i < cl.n; i++) kmax = Math.max(kmax, Math.abs(cl.curv[i]));
console.log(`  макс кривизна ${kmax.toFixed(4)} 1/м  (мин радиус ${(1/kmax).toFixed(1)} м)`);

const hist = new Array(8).fill(0);
for (let i = 0; i < cl.n; i++) {
  const r = Math.abs(cl.curv[i]) < 1e-4 ? 1e4 : 1 / Math.abs(cl.curv[i]);
  const b = r > 200 ? 0 : r > 100 ? 1 : r > 60 ? 2 : r > 40 ? 3 : r > 25 ? 4 : r > 15 ? 5 : r > 10 ? 6 : 7;
  hist[b]++;
}
const labels = ['>200м(прямая)','100-200','60-100','40-60','25-40','15-25','10-15','<10м'];
console.log('  распределение радиуса по длине круга:');
hist.forEach((h, i) => console.log(`    ${labels[i].padEnd(16)} ${(h*cl.step).toFixed(0).padStart(4)} м  ${(100*h/cl.n).toFixed(1)}%`));

const corners = detectCorners(cl);
console.log(`\n=== ПОВОРОТЫ: найдено ${corners.length} ===`);
for (const c of corners) {
  console.log(`  ${c.name.padEnd(4)} ${c.dir}  вход ${c.sStart.toFixed(0).padStart(4)}м  апекс ${c.sApex.toFixed(0).padStart(4)}м  выход ${c.sEnd.toFixed(0).padStart(4)}м  длина ${(c.sEnd-c.sStart).toFixed(0).padStart(3)}м  R=${c.radius.toFixed(1)}м`);
}
