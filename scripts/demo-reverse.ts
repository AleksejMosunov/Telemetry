/** Проверка на живых данных: как поведёт себя загрузка, если та же трасса
 *  проезжается в обратную сторону. Запуск: npx tsx scripts/demo-reverse.ts */
import { readFileSync } from 'fs';
import { parseAimCsv } from '../src/core/parse';
import { analyzeSessions } from '../src/core/pipeline';
import { matchTracks, findConfig, type TrackSignature } from '../src/core/trackid';

const D = '/Users/macbook/Documents/karting/telemetry/csv';
const sig = analyzeSessions([parseAimCsv(readFileSync(`${D}/1.csv`, 'utf8'), '1')]).signature;

// в базе уже лежит эта конфигурация
const known = [{ id: 'cfg-1', trackId: 't-2g', trackName: '2G', name: 'OSOKORKY REVERS', signature: sig }];

// та же геометрия, но обход в обратную сторону
const back: TrackSignature = { ...sig, outline: [] };
for (let i = sig.outline.length / 2 - 1; i >= 0; i--) {
  back.outline.push(sig.outline[i * 2], sig.outline[i * 2 + 1]);
}

for (const [label, s] of [['тот же заезд', sig], ['в обратную сторону', back]] as const) {
  const hit = findConfig(s, known);
  const m = matchTracks(s, known[0].signature);
  const venue = known.find(c => matchTracks(s, c.signature).sameVenue);
  console.log(`\n${label}`);
  console.log(`  геометрия: разброс ${m.spread.toFixed(1)} м, длина ${(m.lengthDiff * 100).toFixed(2)}%`);
  console.log(`  направление: ${m.sameDirection ? 'то же' : 'ОБРАТНОЕ'}`);
  console.log(`  площадка: ${venue ? `узнана, «${venue.trackName}»` : 'не узнана'}`);
  console.log(`  окно загрузки покажет: ${hit
    ? `«${hit.config.trackName} · ${hit.config.name}» — узнал по траектории (расхождение ${hit.match.spread.toFixed(1)} м)`
    : venue
      ? `«Площадка «${venue.trackName}» знакома, но конфигурация новая» — спросит только название конфигурации`
      : '«Новая трасса» — спросит название трассы и конфигурации'}`);
}
