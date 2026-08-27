import { readFileSync } from 'fs';
import { gzipSync } from 'zlib';
import { analyze, analyzeSessions } from '../src/core/pipeline';
import { parseAimCsv } from '../src/core/parse';
import { packSession, unpackSession } from '../src/core/pack';
import { matchTracks, type TrackSignature } from '../src/core/trackid';
import { sessionFingerprint } from '../src/core/identity';
import { buildInsights } from '../src/ui/insights';

const DIR = '/Users/macbook/Documents/karting/telemetry/csv';
const FILES = ['1.csv', '2.csv'].map(n => ({ name: n, text: readFileSync(`${DIR}/${n}`, 'utf8') }));
const t0 = Date.now();
const a = analyze(FILES);
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

// Снятие круга: цифры обязаны поехать, а нумерация поворотов — нет.
const victim = a.drivers[1];
const cutLap = victim.laps.filter(l => l.clean).sort((x, y) => y.time - x.time)[0].index;
const b = analyze(FILES, { [victim.fingerprint]: [cutLap] });
const vb = b.drivers[1];
checks.push(['снятый круг выпал из расчёта',
  vb.laps.filter(l => l.clean).length === victim.laps.filter(l => l.clean).length - 1
  && vb.laps.find(l => l.index === cutLap)?.excluded === true,
  `#${cutLap}`]);
checks.push(['снятый круг остался виден в таблице стабильности',
  vb.excludedRows.length === 1 && vb.excludedRows[0].lapIndex === cutLap
  && vb.excludedRows[0].row.length === b.zones.length, '']);
checks.push(['нумерация поворотов от снятия не поплыла',
  b.corners.length === a.corners.length
  && b.corners.every((c, i) => Math.abs(c.sApex - a.corners[i].sApex) < 1), '']);
// Медиана от снятия одного крайнего круга смещаться не обязана — а разброс обязан.
checks.push(['снятие самого медленного круга сузило разброс',
  vb.stats.sd < victim.stats.sd && vb.stats.median <= victim.stats.median,
  `σ ${victim.stats.sd.toFixed(3)} -> ${vb.stats.sd.toFixed(3)}`]);
checks.push(['зоны по-прежнему в сумме дают усреднённый круг',
  Math.abs(vb.zoneMed.reduce((s2, z) => s2 + z.tZone, 0) - vb.medT[b.grid.length - 1]) < 0.01, '']);
const allCut = analyze(FILES, { [victim.fingerprint]: victim.laps.map(l => l.index) });
checks.push(['снять все круги нельзя — заезд остаётся считаемым',
  allCut.drivers[1].laps.filter(l => l.clean).length >= 2 && allCut.warnings.length > 0,
  allCut.warnings[0] ?? 'предупреждения нет']);
const susp = a.drivers.flatMap(d => d.laps.filter(l => l.suspect).map(l => `${d.id}#${l.index} ${a.zones[l.suspect!.zone].corner.name} +${l.suspect!.loss.toFixed(3)}`));
checks.push(['детектор помех не сыплет ложными срабатываниями',
  susp.length <= Math.ceil(0.1 * a.drivers.reduce((n, d) => n + d.laps.filter(l => l.clean).length, 0)),
  susp.length ? susp.join(', ') : 'подозрительных кругов нет']);

// Компактный формат хранилища: то, что уехало в облако и вернулось, обязано
// давать ровно тот же анализ, иначе архив сезона будет врать.
const sess = FILES.map(f => parseAimCsv(f.text, f.name));
const packed = sess.map(packSession);
const rt = analyzeSessions(packed.map(unpackSession));
const gzTotal = packed.reduce((n, b) => n + gzipSync(Buffer.from(b), { level: 9 }).length, 0);
const csvTotal = FILES.reduce((n, f) => n + f.text.length, 0);
checks.push(['компактный формат: та же трасса',
  rt.corners.length === a.corners.length && Math.abs(rt.track.length - a.track.length) < 0.1, '']);
let dLap = 0, dZone = 0;
for (let i = 0; i < a.drivers.length; i++) {
  dLap = Math.max(dLap, Math.abs(rt.drivers[i].stats.best - a.drivers[i].stats.best),
    Math.abs(rt.drivers[i].stats.median - a.drivers[i].stats.median));
  for (let z = 0; z < a.zones.length; z++) {
    dZone = Math.max(dZone, Math.abs(rt.drivers[i].zoneMed[z].tZone - a.drivers[i].zoneMed[z].tZone));
  }
}
checks.push(['компактный формат: времена кругов не поехали', dLap < 1e-9, `макс ${dLap.toExponential(1)} с`]);
checks.push(['компактный формат: времена зон в пределах шума GPS', dZone < 0.01, `макс ${dZone.toFixed(4)} с`]);
checks.push(['компактный формат: выигрыш по объёму не меньше 20x',
  csvTotal / gzTotal > 20,
  `${(csvTotal / 1048576).toFixed(1)} МБ CSV -> ${(gzTotal / 1024).toFixed(0)} КБ (${(csvTotal / gzTotal).toFixed(0)}x)`]);

// Опознание трассы. Каждую сессию разбираем отдельно — так и будет при загрузке
// по одной. Проверяем и что своё сходится, и что чужое отсекается.
const sigA = analyzeSessions([sess[0]]).signature;
const sigB = analyzeSessions([sess[1]]).signature;
const nOut = sigB.outline.length / 2;
const shifted = (frac: number, off: number): TrackSignature => {
  const v = { ...sigB, outline: [...sigB.outline] };
  const from = Math.floor(nOut * 0.4), to = from + Math.max(1, Math.floor(nOut * frac));
  for (let i = from; i < to; i++) v.outline[i * 2] += off;
  return v;
};
const reversed: TrackSignature = { ...sigA, outline: [] };
for (let i = sigA.outline.length / 2 - 1; i >= 0; i--) {
  reversed.outline.push(sigA.outline[i * 2], sigA.outline[i * 2 + 1]);
}
const restarted: TrackSignature = {
  ...sigB,
  outline: [...sigB.outline.slice(Math.floor(nOut * 0.3) * 2), ...sigB.outline.slice(0, Math.floor(nOut * 0.3) * 2)],
};
const real = matchTracks(sigA, sigB);
const tcase = (name: string, m: ReturnType<typeof matchTracks>, want: boolean) =>
  checks.push([`трасса: ${name}`, m.sameConfig === want, `разброс ${m.spread.toFixed(1)} м`]);
tcase('две сессии одной трассы — одна конфигурация', real, true);
tcase('другая линия старта — та же конфигурация', matchTracks(sigA, restarted), true);
tcase('снос GPS на 4 м не мешает', matchTracks(sigA, { ...sigB, outline: sigB.outline.map((v, i) => (i % 2 === 0 ? v + 4 : v)) }), true);
tcase('сдвиг в пределах ширины трассы — та же', matchTracks(sigA, shifted(0.10, 6)), true);
tcase('участок уведён на 10 м — другая', matchTracks(sigA, shifted(0.10, 10)), false);
tcase('короткий участок уведён на 25 м — другая', matchTracks(sigA, shifted(0.03, 25)), false);
tcase('обратное направление — другая', matchTracks(sigA, reversed), false);
tcase('другая площадка — другая', matchTracks(sigA, { ...sigB, lat: sigB.lat + 0.045 }), false);
checks.push(['трасса: запас между своим и чужим не меньше двукратного',
  matchTracks(sigA, shifted(0.10, 10)).spread / real.spread > 2,
  `своё ${real.spread.toFixed(1)} м против чужого ${matchTracks(sigA, shifted(0.10, 10)).spread.toFixed(1)} м`]);

// Опознание сессии
checks.push(['отпечатки заездов различаются',
  sessionFingerprint(sess[0]) !== sessionFingerprint(sess[1]) && sessionFingerprint(sess[0]).length > 0,
  sessionFingerprint(sess[0])]);
checks.push(['отпечаток не зависит от имени файла',
  sessionFingerprint(sess[0]) === sessionFingerprint(parseAimCsv(FILES[0].text, 'другое-имя.csv')), '']);

// ── сектора ───────────────────────────────────────────────────────────────
const secLen = a.sectors.reduce((p, c) => p + c.length, 0);
checks.push(['сектора покрывают круг целиком',
  Math.abs(secLen - a.track.length) < 0.5,
  `${secLen.toFixed(1)} м против ${a.track.length.toFixed(1)} м`]);
checks.push(['сектора идут подряд и без дыр',
  a.sectors.every((x, i) => x.from === (i === 0 ? 0 : a.sectors[i - 1].to + 1))
  && a.sectors[a.sectors.length - 1].to === a.zones.length - 1, '']);

for (const d of a.drivers) {
  const secTime = (from: number, to: number) => d.zoneByLap.map(r => {
    let t = 0; for (let z = from; z <= to; z++) t += r[z];
    return t;
  });
  const bySector = a.sectors.reduce((p, x) => p + Math.min(...secTime(x.from, x.to)), 0);
  const byZone = Array.from({ length: a.zones.length },
    (_, z) => Math.min(...d.zoneByLap.map(r => r[z]))).reduce((p, c) => p + c, 0);
  const bestLap = Math.min(...d.zoneByLap.map(r => r.reduce((p, c) => p + c, 0)));
  // круг из секторов зажат между суммой лучших зон и лучшим реальным кругом
  checks.push([`потенциал по секторам между зонным и реальным (${d.name})`,
    byZone <= bySector + 1e-9 && bySector <= bestLap + 1e-9,
    `зоны ${byZone.toFixed(3)} ≤ сектора ${bySector.toFixed(3)} ≤ круг ${bestLap.toFixed(3)}`]);
}

// Точка распрямления должна находиться в каждом повороте и лежать после апекса,
// но до следующего элемента трассы — иначе метрика меряет уже не этот поворот.
for (const d of a.drivers) {
  const u = Array.from(d.unwindByZone);
  const found = u.filter(v => isFinite(v));
  // Прочерк — законный ответ: в связке карт не распрямляется до следующего поворота.
  // А вот значение за входом в следующий поворот означало бы, что поиск его перескочил.
  checks.push([`точка распрямления не выходит за следующий поворот (${d.name})`,
    u.every((v, i) => {
      if (!isFinite(v)) return true;
      let win = a.zones[(i + 1) % a.zones.length].corner.sStart - a.zones[i].corner.sApex;
      if (win < 0) win += a.track.length;
      return v >= 0 && v <= win;
    }),
    `${found.length} из ${a.zones.length} поворотов со значением`]);
}
// Регрессия на конкретный баг: до требования удержания метрика ловила в шпильке T6
// мгновенный сброс дуги на +4 м и рисовала несуществующую разницу в 30 м между
// пилотами. Настоящее распрямление там — за 25 м после апекса, и оно у обоих одно.
{
  const t6 = a.zones.findIndex(z => z.corner.name === 'T6');
  const vals = a.drivers.map(d => d.unwindByZone[t6]);
  checks.push(['T6: распрямление не срабатывает на сбросе дуги в середине шпильки',
    t6 >= 0 && vals.every(v => v >= 25),
    vals.map(v => `${v.toFixed(0)} м`).join(', ')]);
}

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
