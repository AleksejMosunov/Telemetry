import { readFileSync } from 'fs';
import { parseAimCsv, ch } from '../src/core/parse';
import { makeProjector, project } from '../src/core/geo';
import { splitLaps, cleanLaps, buildCenterline, detectCorners } from '../src/core/track';
import { makeGrid } from '../src/core/align';
import { buildLapTrace, buildZones, zoneStats } from '../src/core/analysis';

const DIR = '/Users/macbook/Documents/karting/telemetry/csv';
const A = parseAimCsv(readFileSync(`${DIR}/1.csv`, 'utf8'), 'Пилот A (16:00)');
const B = parseAimCsv(readFileSync(`${DIR}/2.csv`, 'utf8'), 'Пилот B (15:31)');

const lapsA = cleanLaps(splitLaps(A)), lapsB = cleanLaps(splitLaps(B));
const bestA = lapsA.reduce((a, b) => (a.time <= b.time ? a : b));
const bestB = lapsB.reduce((a, b) => (a.time <= b.time ? a : b));

// осевая линия — из лучшего круга A
const latA = ch(A, 'GPS Latitude'), lonA = ch(A, 'GPS Longitude');
const proj = makeProjector(latA[bestA.i0], lonA[bestA.i0]);
const bx: number[] = [], by: number[] = [];
for (let i = bestA.i0; i < bestA.i1; i++) { const [x, y] = project(proj, latA[i], lonA[i]); bx.push(x); by.push(y); }
const cl = buildCenterline(bx, by, proj, 1.0, 6);
const grid = makeGrid(cl.length, 1.0);
const corners = detectCorners(cl);
const zones = buildZones(corners, cl.length);

const trA = buildLapTrace(A, bestA, cl, grid);
const trB = buildLapTrace(B, bestB, cl, grid);
const zA = zoneStats(trA, zones, grid), zB = zoneStats(trB, zones, grid);

console.log(`\nЛучший круг A ${bestA.time.toFixed(3)} (круг #${bestA.index})   B ${bestB.time.toFixed(3)} (круг #${bestB.index})`);
console.log(`Дельта ${(bestB.time - bestA.time).toFixed(3)} с\n`);
console.log(`Реально пройдено за круг:  A ${trA.pathLength.toFixed(1)} м   B ${trB.pathLength.toFixed(1)} м   (осевая ${cl.length.toFixed(1)} м)`);
console.log(`  разница ${(trB.pathLength - trA.pathLength).toFixed(1)} м\n`);

console.log('ПОТЕРИ ПО ЗОНАМ (B относительно A, + = B теряет)');
console.log('зона  R      Δt      | апекс км/ч        | вход км/ч       | выход км/ч      | торможение');
console.log('                     |  A     B    Δ     |  A     B        |  A     B        |  A     B     Δ');
console.log('-'.repeat(100));
let sum = 0;
const rows = zones.map((z, i) => {
  const dt = zB[i].tZone - zA[i].tZone; sum += dt;
  let dBrake = zB[i].sBrake - zA[i].sBrake;
  if (dBrake > cl.length / 2) dBrake -= cl.length;
  if (dBrake < -cl.length / 2) dBrake += cl.length;
  return { z, i, dt, dBrake };
});
for (const { z, i, dt, dBrake } of rows) {
  const c = z.corner;
  console.log(
    `${c.name.padEnd(4)} ${c.radius.toFixed(0).padStart(3)}м ${(dt >= 0 ? '+' : '')}${dt.toFixed(3).padStart(6)} | ` +
    `${zA[i].vMin.toFixed(1).padStart(5)} ${zB[i].vMin.toFixed(1).padStart(5)} ${(zB[i].vMin - zA[i].vMin >= 0 ? '+' : '')}${(zB[i].vMin - zA[i].vMin).toFixed(1).padStart(5)} | ` +
    `${zA[i].vEntry.toFixed(1).padStart(5)} ${zB[i].vEntry.toFixed(1).padStart(5)}   | ` +
    `${zA[i].vExit.toFixed(1).padStart(5)} ${zB[i].vExit.toFixed(1).padStart(5)}   | ` +
    `${zA[i].sBrake.toFixed(0).padStart(4)} ${zB[i].sBrake.toFixed(0).padStart(4)} ${(dBrake >= 0 ? '+' : '')}${dBrake.toFixed(0).padStart(4)}м`
  );
}
console.log('-'.repeat(100));
console.log(`сумма по зонам ${sum >= 0 ? '+' : ''}${sum.toFixed(3)} с   (дельта круга ${(bestB.time - bestA.time).toFixed(3)} с)`);

console.log('\nТОП потерь:');
[...rows].sort((p, q) => q.dt - p.dt).slice(0, 4).forEach(r =>
  console.log(`  ${r.z.corner.name}: ${r.dt >= 0 ? '+' : ''}${r.dt.toFixed(3)} с`));
console.log('Где B быстрее:');
[...rows].sort((p, q) => p.dt - q.dt).slice(0, 3).filter(r => r.dt < 0).forEach(r =>
  console.log(`  ${r.z.corner.name}: ${r.dt.toFixed(3)} с`));
