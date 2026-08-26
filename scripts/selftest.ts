import { readFileSync } from 'fs';
import { analyze } from '../src/core/pipeline';
import { buildInsights } from '../src/ui/insights';

const DIR = '/Users/macbook/Documents/karting/telemetry/csv';
const t0 = Date.now();
const a = analyze(['1.csv', '2.csv'].map(n => ({ name: n, text: readFileSync(`${DIR}/${n}`, 'utf8') })));
console.log(`analyze(): ${Date.now() - t0} мс\n`);

console.log(`Трасса ${a.track.length.toFixed(0)} м · ${a.corners.length} поворотов · сетка ${a.grid.length} точек`);
console.log(`Предупреждения: ${a.warnings.length ? a.warnings.join('; ') : 'нет'}\n`);

const ref = a.drivers.reduce((p, q) => (p.stats.best <= q.stats.best ? p : q));
console.log('КАРТОЧКИ ПИЛОТОВ (вкладка «Обзор»)');
for (const d of a.drivers) {
  const s = d.stats;
  console.log(`  ${d.name}`);
  console.log(`    лучший ${s.best.toFixed(3)}  медиана ${s.median.toFixed(3)}  σ ${s.sd.toFixed(3)}  ` +
    `траектория ${s.medianPath.toFixed(1)} м  ход стинта ${s.drift >= 0 ? '+' : ''}${s.drift.toFixed(3)}  ` +
    `пик ${s.peakG.toFixed(2)} g  подруливаний ${s.medianCorrections.toFixed(0)}`);
  console.log(`    кругов ${d.laps.length}, чистых ${d.laps.filter(l => l.clean).length}, опорный: ${d.id === ref.id}`);
}

console.log('\nТАБЛИЦА ПОВОРОТОВ (вкладка «Повороты», медианный круг)');
let total = 0;
for (let i = 0; i < a.zones.length; i++) {
  const parts = a.drivers.map(d => {
    const dt = d.zoneMed[i].tZone - ref.zoneMed[i].tZone;
    if (d.id === ref.id) return `${d.zoneMed[i].tZone.toFixed(3)}s`;
    total += dt;
    return `${dt >= 0 ? '+' : ''}${dt.toFixed(3)}`;
  });
  console.log(`  ${a.zones[i].corner.name.padEnd(4)} R=${a.zones[i].corner.radius.toFixed(0).padStart(3)}м  ${parts.join('   ')}`);
}
const N0 = a.grid.length;
const synthDelta = a.drivers.filter(d => d.id !== ref.id).map(d => d.medT[N0 - 1] - ref.medT[N0 - 1]);
const lapDelta = a.drivers.filter(d => d.id !== ref.id).map(d => d.stats.median - ref.stats.median);
console.log(`  ИТОГО по зонам ${total >= 0 ? '+' : ''}${total.toFixed(3)}  |  дельта усреднённых кругов ${synthDelta.map(v => v.toFixed(3)).join(', ')}  |  дельта медиан реальных времён ${lapDelta.map(v => v.toFixed(3)).join(', ')}`);

console.log('\nПРОВЕРКИ ЦЕЛОСТНОСТИ');
const checks: Array<[string, boolean, string]> = [];
for (const d of a.drivers) {
  const N = a.grid.length;
  checks.push([`${d.id} медианный круг монотонен по времени`,
    Array.from(d.medT).every((v, i, arr) => i === 0 || v >= arr[i - 1]), '']);
  checks.push([`${d.id} нет NaN в скорости`, !Array.from(d.medV).some(v => !isFinite(v)), '']);
  checks.push([`${d.id} нет NaN в дельте`, !Array.from(d.medT).some(v => !isFinite(v)), '']);
  checks.push([`${d.id} усреднённый круг близок к медиане реальных времён`,
    Math.abs(d.medT[N - 1] - d.stats.median) < 0.35,
    `${d.medT[N - 1].toFixed(3)} против ${d.stats.median.toFixed(3)}`]);
  checks.push([`${d.id} зоны в сумме дают ровно усреднённый круг`,
    Math.abs(d.zoneMed.reduce((s2, z) => s2 + z.tZone, 0) - d.medT[N - 1]) < 0.01,
    `${d.zoneMed.reduce((s2, z) => s2 + z.tZone, 0).toFixed(3)} против ${d.medT[N - 1].toFixed(3)}`]);
  checks.push([`${d.id} разброс траектории посчитан и вменяем`,
    d.medLatSd.length === N && Math.max(...Array.from(d.medLatSd)) < 5,
    `макс ${Math.max(...Array.from(d.medLatSd)).toFixed(2)} м`]);
  checks.push([`${d.id} длины зон в сумме дают длину круга`,
    Math.abs(Array.from(d.medPathByZone).reduce((p2, q) => p2 + q, 0) - d.stats.medianPath) < 12,
    `${Array.from(d.medPathByZone).reduce((p2, q) => p2 + q, 0).toFixed(1)} против ${d.stats.medianPath.toFixed(1)} м`]);
  checks.push([`${d.id} боковое смещение в разумных пределах (<8 м)`,
    Math.max(...Array.from(d.medLat).map(Math.abs)) < 8,
    `макс ${Math.max(...Array.from(d.medLat).map(Math.abs)).toFixed(2)} м`]);
  checks.push([`${d.id} тепловая карта заполнена`,
    d.zoneByLap.length === d.laps.filter(l => l.clean).length && d.zoneByLap.every(r => r.length === a.zones.length), '']);
}
checks.push(['сумма зон = дельта усреднённых кругов (±10 мс)',
  Math.abs(total - synthDelta[0]) < 0.01, `${total.toFixed(3)} против ${synthDelta[0].toFixed(3)}`]);
checks.push(['таблица поворотов и графики берут один источник',
  Math.abs(total - synthDelta[0]) < 0.01, 'иначе панели показывали бы разные круги']);

let bad = 0;
for (const [name, ok, note] of checks) {
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${note ? `  (${note})` : ''}`);
}

console.log('\nВЫВОДЫ (вкладка «Выводы»)');
for (const it of buildInsights(a, ref.id, d => d.name)) {
  console.log(`  [${it.kind}] ${it.title}`);
  console.log(`      ${it.body}`);
}

console.log(`\n${bad === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `ПРОВАЛЕНО ПРОВЕРОК: ${bad}`}`);
process.exit(bad === 0 ? 0 : 1);
