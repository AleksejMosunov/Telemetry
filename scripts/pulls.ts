import { readFileSync } from 'fs';
import { analyze } from '../src/core/pipeline';
import { buildPulls, verdict } from '../src/core/engine';

const DIR = '/Users/macbook/Documents/karting/telemetry/csv';
const files = ['1.csv', '2.csv'].map(n => ({ name: n, text: readFileSync(`${DIR}/${n}`, 'utf8') }));
const a = analyze(files);

console.log(`\nТрасса ${a.track.length.toFixed(0)} м · ${a.corners.length} поворотов`);
for (const d of a.drivers) {
  console.log(`  ${d.id} ${d.name}  медиана ${d.stats.median.toFixed(3)}  кругов ${d.traces.length}`);
}

const rep = buildPulls(a.drivers, a.corners, a.grid, a.track.length);
const ref = a.drivers[0];

console.log(`\nРАЗГОННЫЕ ВОРОТА  (пригодных прямых ${rep.used} из ${rep.rows.length})`);
console.log('прямая        длина   ворота       ' + a.drivers.map(d => d.id.padStart(16)).join(''));
console.log('-'.repeat(60 + 16 * a.drivers.length));
for (const r of rep.rows) {
  const head = `${r.straight.label.padEnd(12)} ${r.straight.length.toFixed(0).padStart(5)} м`;
  if (!r.gate) { console.log(`${head}  — ${r.skip}`); continue; }
  const g = `${r.gate.vLo}→${r.gate.vHi} км/ч`.padEnd(13);
  const cells = r.cells.map(c =>
    (isFinite(c.dist) ? `${c.dist.toFixed(1)}м ±${(isFinite(c.se) ? c.se : 0).toFixed(1)} n${c.n}` : '—')
      .padStart(16)).join('');
  console.log(`${head}  ${g}${cells}${r.skip ? '   ← ' + r.skip : ''}`);
}

console.log('\nИТОГО по пригодным прямым');
for (const t of rep.totals) {
  const d = a.drivers.find(x => x.id === t.driverId)!;
  const r0 = rep.totals[0];
  const dd = t.dist - r0.dist;
  console.log(`  ${d.name.padEnd(28)} ${t.dist.toFixed(1)} м  ±${t.se.toFixed(1)}` +
    (t.driverId === ref.id ? '  (опорный)' : `   ${dd > 0 ? '+' : '−'}${Math.abs(dd).toFixed(1)} м  ${(100 * dd / r0.dist).toFixed(1)}%`));
}

console.log('');
for (const d of a.drivers) {
  if (d.id === ref.id) continue;
  const v = verdict(rep, ref.id, d.id);
  console.log(`  ${d.name}: ${v.pct.toFixed(1)}% — ${v.text}`);
}
console.log('');
