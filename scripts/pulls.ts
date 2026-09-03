import { readFileSync } from 'fs';
import { analyze } from '../src/core/pipeline';
import { buildPulls, verdict, noiseFloor } from '../src/core/engine';

const DIR = '/Users/macbook/Documents/karting/telemetry/csv';
const files = ['1.csv', '2.csv'].map(n => ({ name: n, text: readFileSync(`${DIR}/${n}`, 'utf8') }));
const a = analyze(files);

console.log(`\nТрасса ${a.track.length.toFixed(0)} м · ${a.corners.length} поворотов`);
for (const d of a.drivers) {
  console.log(`  ${d.id} ${d.name}  медиана ${d.stats.median.toFixed(3)}  кругов ${d.traces.length}`);
}

const rep = buildPulls(a.drivers, a.corners, a.grid, a.track.length);
const ref = a.drivers[0];

console.log(`\nРАЗГОННЫЕ ВОРОТА  (пригодных участков ${rep.used} из ${rep.rows.length}, без нагрузки ${rep.cleanUsed})`);
console.log('участок       длина   ворота       нагрузка' + a.drivers.map(d => d.id.padStart(18)).join(''));
console.log('-'.repeat(60 + 16 * a.drivers.length));
for (const r of rep.rows) {
  const head = `${r.section.label.padEnd(12)} ${r.section.length.toFixed(0).padStart(5)} м`;
  if (!r.gate) { console.log(`${head}  — ${r.skip}`); continue; }
  const g = `${r.gate.vLo}→${r.gate.vHi} км/ч`.padEnd(13);
  const gs = r.cells.map(c => c.latG).filter(isFinite);
  const gg = (gs.length ? `${Math.min(...gs).toFixed(2)}/${Math.max(...gs).toFixed(2)}` : '  —  ') + (r.clean ? '  ' : ' *');
  const cells = r.cells.map(c =>
    (isFinite(c.dist) ? `${c.dist.toFixed(1)} b${c.distBest.toFixed(1)} ±${(isFinite(c.se) ? c.se : 0).toFixed(1)} n${c.n}/${c.nTotal}` : '—')
      .padStart(18)).join('');
  console.log(`${head}  ${g}${gg}${cells}${r.skip ? '   ← ' + r.skip : ''}`);
}

console.log('\n(b = лучший разгон p20, n = кругов уложилось/всего, нагрузка = мин/макс по участникам, * = участок не судит мотор)');
console.log('\nИТОГО по пригодным участкам');
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
  for (const m of ['median', 'best'] as const) {
    const v = verdict(rep, ref.id, d.id, m);
    console.log(`  [${m.padEnd(6)}] ${d.name}: ${v.pct.toFixed(1)}% — ${v.text}`);
    if (v.note) console.log(`            ${v.note}`);
  }
  console.log(`  шумовой пол: медиана ${noiseFloor(ref, a.corners, a.grid, a.track.length).toFixed(2)}%, лучшие ${noiseFloor(ref, a.corners, a.grid, a.track.length, 'best').toFixed(2)}%`);
}
console.log('');
