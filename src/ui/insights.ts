import { time24, type Analysis, type DriverResult } from '../core/pipeline';

export interface Insight {
  kind: 'key' | 'pattern' | 'note' | 'caveat';
  title: string;
  body: string;
}

const corr = (x: number[], y: number[]) => {
  const n = x.length;
  if (n < 5) return NaN;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const d = Math.sqrt(sxx * syy);
  return d ? sxy / d : NaN;
};

const at = (arr: Float64Array, s: number) => arr[Math.max(0, Math.min(arr.length - 1, Math.round(s)))];

/** Выводы формулируются только по тем связям, которые подтверждаются данными самой сессии. */
export function buildInsights(a: Analysis, refId: string, name: (d: DriverResult) => string): Insight[] {
  const ref = a.drivers.find(d => d.id === refId) ?? a.drivers[0];
  const out: Insight[] = [];

  // --- связь длины траектории со временем внутри стинта (проверяем, а не постулируем) ---
  const rs = a.drivers.map(d => {
    const cl = d.laps.filter(l => l.clean);
    return corr(cl.map(l => l.pathLength), cl.map(l => l.time));
  }).filter(r => !isNaN(r));
  const rMed = rs.length ? [...rs].sort((p, q) => p - q)[rs.length >> 1] : NaN;

  for (const d of a.drivers) {
    if (d.id === ref.id) continue;
    const dPath = d.stats.medianPath - ref.stats.medianPath;
    const sigma = Math.hypot(d.stats.pathSd, ref.stats.pathSd) || 1;
    if (Math.abs(dPath) > 2 && Math.abs(dPath) / sigma > 1.5) {
      out.push({
        kind: 'key',
        title: `${name(d)}: траектория ${dPath > 0 ? 'длиннее' : 'короче'} на ${Math.abs(dPath).toFixed(1)} м за круг`,
        body: `${d.stats.medianPath.toFixed(1)} м против ${ref.stats.medianPath.toFixed(1)} м у «${name(ref)}» — ` +
          `это в ${(Math.abs(dPath) / sigma).toFixed(1)} раза больше обычного разброса между кругами, то есть не случайность.` +
          (isFinite(rMed) && rMed > 0.4
            ? ` В этой сессии длина траектории — самый предсказательный показатель: внутри одного стинта она связана со временем круга с r=${rMed.toFixed(2)}.`
            : ''),
      });
    }
  }

  // --- вход против выхода ---
  for (const d of a.drivers) {
    if (d.id === ref.id) continue;
    let exitWorse = 0, apexBetter = 0;
    for (let i = 0; i < a.corners.length; i++) {
      const c = a.corners[i];
      if (at(d.medV, c.sEnd) < at(ref.medV, c.sEnd) - 0.15) exitWorse++;
      if (at(d.medV, c.sApex) > at(ref.medV, c.sApex) + 0.15) apexBetter++;
    }
    const N = a.corners.length;
    if (N >= 4 && exitWorse / N >= 0.65) {
      const hint = apexBetter / N >= 0.35
        ? ` При этом в низшей точке он быстрее в ${apexBetter} из ${N} — скорость в повороте есть, а на выходе её нет. ` +
          `Типичная картина перебора на входе: карт не встаёт на дугу, руль остаётся повёрнутым, газ открывается позже.`
        : '';
      out.push({
        kind: 'pattern',
        title: `${name(d)}: медленнее на выходе в ${exitWorse} из ${N} поворотов`,
        body: `Потеря не в одном месте, а системная.${hint}`,
      });
    }
  }

  // --- где именно теряется время ---
  for (const d of a.drivers) {
    if (d.id === ref.id) continue;
    const losses = a.zones.map((z, i) => ({ z, dt: d.zoneMed[i].tZone - ref.zoneMed[i].tZone }));
    const top = [...losses].sort((p, q) => q.dt - p.dt).slice(0, 3).filter(l => l.dt > 0.02);
    if (top.length) {
      out.push({
        kind: 'note',
        title: `${name(d)}: крупнейшие потери — ${top.map(t => t.z.corner.name).join(', ')}`,
        body: top.map(t =>
          `${t.z.corner.name} (+${t.dt.toFixed(3)} с, мин. скорость ${d.zoneMed[a.zones.indexOf(t.z)].vMin.toFixed(1)} против ${ref.zoneMed[a.zones.indexOf(t.z)].vMin.toFixed(1)} км/ч)`
        ).join('; ') + '.',
      });
    }
  }

  // --- сцепление: одинаковый пик = вопрос техники, а не смелости ---
  const gs = a.drivers.map(d => d.stats.peakG).filter(v => isFinite(v));
  if (gs.length >= 2 && Math.max(...gs) - Math.min(...gs) < 0.12) {
    out.push({
      kind: 'note',
      title: 'Пиковые перегрузки практически совпадают',
      body: `${a.drivers.filter(d => isFinite(d.stats.peakG)).map(d => `${name(d)} ${d.stats.peakG.toFixed(2)} g`).join(', ')}. ` +
        `Значит разница не в сцеплении и не в готовности давить, а в технике.` +
        (a.drivers.every(d => isFinite(d.stats.comboPct))
          ? ` Комбинированная нагрузка (поворот под тягой): ${a.drivers.map(d => `${name(d)} ${d.stats.comboPct.toFixed(1)}%`).join(', ')} времени круга.`
          : ''),
    });
  }

  // --- ход стинта ---
  for (const d of a.drivers) {
    if (Math.abs(d.stats.drift) > 0.12) {
      out.push({
        kind: d.stats.drift < 0 ? 'note' : 'caveat',
        title: `${name(d)}: ${d.stats.drift < 0 ? 'прогрессирует по ходу стинта' : 'замедляется к концу стинта'}`,
        body: `Первая половина ${d.stats.firstHalf.toFixed(3)} → вторая ${d.stats.secondHalf.toFixed(3)} с ` +
          `(${d.stats.drift > 0 ? '+' : '−'}${Math.abs(d.stats.drift).toFixed(3)}).` +
          (d.stats.drift < 0 ? ' Стинт мог закончиться раньше, чем он вышел на свой предел.' : ' Стоит смотреть на резину, топливо и усталость.'),
      });
    }
  }

  // --- честная оговорка про разное время выезда ---
  const times = a.drivers.map(d => time24(d.meta['Time'])).filter(Boolean);
  if (new Set(times).size > 1 && a.drivers.length > 1) {
    const order = [...a.drivers].sort((p, q) => time24(p.meta['Time']).localeCompare(time24(q.meta['Time'])));
    out.push({
      kind: 'caveat',
      title: 'Заезды сделаны в разное время',
      body: `Выезжали в ${order.map(d => time24(d.meta['Time'])).join(' и ')} — раньше всех «${name(order[0])}». ` +
        `Часть разницы во времени круга может быть разогревом трассы и остатком топлива, а не пилотом. ` +
        `Сравнение по форме траектории и по скорости на выходе от этого не страдает — оно надёжнее абсолютных времён.`,
    });
  }

  // --- стиль руления: измерено надёжно, но причинность не доказана ---
  const cs = a.drivers.filter(d => isFinite(d.stats.medianCorrections));
  if (cs.length >= 2) {
    const mn = cs.reduce((p, q) => (p.stats.medianCorrections <= q.stats.medianCorrections ? p : q));
    const mx = cs.reduce((p, q) => (p.stats.medianCorrections >= q.stats.medianCorrections ? p : q));
    if (mx.stats.medianCorrections > mn.stats.medianCorrections * 1.3) {
      out.push({
        kind: 'note',
        title: `Стиль руления: ${name(mx)} подруливает ${mx.stats.medianCorrections.toFixed(0)} раз за круг против ${mn.stats.medianCorrections.toFixed(0)} у ${name(mn)}`,
        body: `Измерено гироскопом, GPS не участвует. Это устойчивая характеристика стиля, но прямой связи ` +
          `с временем круга внутри стинта не видно — считайте это описанием почерка, а не счётом потерянных секунд.`,
      });
    }
  }

  return out;
}
