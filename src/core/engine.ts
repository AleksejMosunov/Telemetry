/**
 * Разгон — оценка тяги карта отдельно от пилота.
 *
 * Наивная метрика «сколько км/ч набрал за N метров от точки распрямления» не
 * работает: тяга падает с ростом скорости (a ≈ P/(m·v) − сопротивление), поэтому
 * тот, кто хуже вышел из поворота, наберёт больше — при одинаковом моторе. Такая
 * метрика систематически награждает плохой выход.
 *
 * Здесь наоборот: скорости фиксируются, а меряется дистанция. «Сколько метров
 * ушло на разгон с 42 до 66 км/ч» — начало отсчёта у всех одинаковое по скорости,
 * и разница в выходе из поворота на результат не влияет.
 *
 * Пороги не заданы числом, а выводятся из самих данных по каждому участку: карт
 * на 437 м может нигде не доехать до 60 км/ч, а на длинной трассе 60 будет уже
 * далеко в разгоне. Побочный эффект полезен: медленный участок меряет низы
 * мотора, быстрый — верхи, и по тому, где именно отстаёт карт, различаются
 * причины.
 */

import type { Corner } from './track';
import type { DriverResult } from './pipeline';

/**
 * Участок разгона: от апекса поворота до входа в следующий.
 *
 * Раньше здесь была геометрическая прямая — промежуток между концом одного
 * поворота и началом следующего. На картодроме с плотными поворотами таких
 * промежутков просто нет: девять «прямых» по три метра, мерить негде. Разгон же
 * есть всегда — от низшей точки скорости до пика перед следующим торможением.
 *
 * Плата за это — участок захватывает выход из поворота, где тягу ограничивает не
 * мотор, а сцепление шин. Поэтому у каждого участка считается боковая нагрузка:
 * по ней видно, какие из них честно меряют мотор, а какие мешают его с
 * траекторией. Прятать это нельзя — иначе цифра выглядит убедительнее, чем есть.
 */
export interface Section {
  id: number;
  label: string;       // «T9 → T1»
  sStart: number;      // апекс поворота, м от старт/финиша
  sEnd: number;        // начало следующего поворота
  length: number;      // м
}

export interface Gate { vLo: number; vHi: number }

export interface PullLap {
  lapIndex: number;
  dist: number;        // м между воротами
  time: number;        // с между воротами
  latG: number;        // средняя боковая нагрузка на разгоне, g (NaN — нет гироскопа)
}

export interface PullCell {
  driverId: string;
  /** медиана дистанции разгона по кругам, м (NaN — ни один круг не прошёл ворота) */
  dist: number;
  time: number;
  /** лучшие разгоны, p20 по кругам, м. Медиана мерит «карт и как его везли»,
   *  лучшие — что карт может, когда пилот в полном газу с самого выхода.
   *  Разрыв, который держится и там и там, объясняется картом, а не манерой. */
  distBest: number;
  timeBest: number;
  latG: number;
  /** оценка погрешности медианы, м — по ней видно, значима ли разница */
  se: number;
  /** сколько кругов уложилось в ворота */
  n: number;
  /** сколько кругов было всего: если уложилась половина, доверия к цифре меньше */
  nTotal: number;
  laps: PullLap[];
}

export interface PullRow {
  section: Section;
  /** null — общего диапазона скоростей на этом участке нет */
  gate: Gate | null;
  /** почему участок не годится */
  skip?: string;
  /** боковая нагрузка на разгоне, g — медиана по участникам */
  latG: number;
  /** насколько по-разному участники нагружают карт на этом разгоне, g */
  latSpread: number;
  /** нагрузка низкая И одинаковая: участок меряет мотор, а не сцепление и траекторию */
  clean: boolean;
  cells: PullCell[];
}

export interface PullReport {
  rows: PullRow[];
  /** сумма дистанций разгона по всем пригодным участкам */
  totals: { driverId: string; dist: number; distBest: number; se: number; n: number }[];
  /** сколько участков удалось померить */
  used: number;
  /** из них с низкой боковой нагрузкой */
  cleanUsed: number;
  /** по каким участкам посчитан итог: только чистые или все померенные */
  scope: 'clean' | 'all';
  /** сколько участков вошло в итог */
  scored: number;
}

/** Медиана — «карт и как его везли», лучшие разгоны — на что карт способен. */
export type PullMode = 'median' | 'best';

/** Минимальная ширина ворот. Уже 5 км/ч — и шум GPS-скорости съедает измерение. */
const MIN_SPAN = 5;

/** Запас от краёв диапазона: у самых границ пересечение ловится на шуме. */
const MARGIN = 1;

/** Боковая нагрузка, ниже которой карт едет достаточно прямо, чтобы разгон
 *  ограничивался мотором, а не сцеплением шин. 0.35 g — примерно четверть
 *  того, что карт держит в повороте. */
const CLEAN_G = 0.35;

/**
 * Насколько по-разному участники могут нагружать карт, чтобы участок ещё судил
 * мотор.
 *
 * Низкой средней нагрузки мало. Если один пилот от низшей точки уже едет прямо, а
 * второй тянет дугу до самого выхода, разгон у них ограничен разным: у первого
 * мотором, у второго сцеплением шин. Средняя по двоим спрячет это ровно
 * посередине и покажет спокойную цифру там, где сравниваются траектории.
 */
const LOAD_GAP = 0.08;

const ringLen = (a: number, b: number, n: number) => ((b - a) % n + n) % n;

function med(a: number[]): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Квантиль по отсортированной копии, без интерполяции — выборки тут по 10–30 кругов. */
function quantile(a: number[], q: number): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.max(0, Math.min(s.length - 1, Math.round(q * (s.length - 1))))];
}

/** Устойчивый разброс: СКО по медиане модулей отклонений. Один круг в трафике не
 *  должен раздувать оценку так, чтобы разница между картами перестала быть видна. */
function mad(a: number[]): number {
  if (a.length < 2) return NaN;
  const m = med(a);
  return 1.4826 * med(a.map(v => Math.abs(v - m)));
}

/**
 * Участки разгона: от апекса поворота до апекса следующего.
 *
 * Границей был вход в следующий поворот — и это обрезало замер там, где за
 * прямой идёт скоростная дуга: карт продолжает разгоняться в ней, а окно уже
 * закончилось, и верх мотора не меряется нигде. Апекс — граница честнее: между
 * двумя апексами гарантированно лежит ровно один пик скорости, и разгон
 * заканчивается на нём, а не на пороге кривизны.
 */
export function buildSections(corners: Corner[], length: number): Section[] {
  const n = corners.length;
  if (n < 2) return [];
  return corners.map((c, i) => {
    const next = corners[(i + 1) % n];
    let len = next.sApex - c.sApex;
    if (len < 0) len += length;
    return {
      id: i + 1,
      label: `${c.name} → ${next.name}`,
      sStart: c.sApex, sEnd: next.sApex, length: len,
    };
  });
}

const idxOf = (grid: Float64Array, s: number) => {
  const step = grid[1] - grid[0];
  const n = grid.length;
  return ((Math.round(s / step) % n) + n) % n;
};

/**
 * Первое пересечение скоростью порога СНИЗУ ВВЕРХ, в дробных шагах сетки.
 *
 * Дробная часть нужна: сетка в 1 м, а вся разница между картами — единицы метров,
 * округление до целого шага съело бы её заметную часть.
 *
 * Если скорость уже выше порога в начале поиска, пересечения нет и круг в замер
 * не идёт. Возвращать здесь начало окна нельзя: разгон тогда меряется не от
 * ворот, а от произвольной точки, и дистанция выходит фальшиво короткой. Именно
 * такие круги первыми попадают в «лучшие разгоны» и раздувают разницу на
 * десятки процентов там, где карт один и тот же.
 */
function crossUp(
  v: Float64Array, i0: number, from: number, len: number, target: number, n: number,
): number {
  if (v[(i0 + from) % n] >= target) return NaN;
  for (let d = from + 1; d <= len; d++) {
    const i = (i0 + d) % n;
    if (v[i] < target) continue;
    const prev = v[(i0 + d - 1) % n];
    const span = v[i] - prev;
    return span > 0 ? d - 1 + (target - prev) / span : d;
  }
  return NaN;
}

/** Время на дробном шаге сетки. Окно может пересекать старт/финиш, где накопленное
 *  время сбрасывается в ноль — тогда к нему добавляется полный круг. */
function timeAt(t: Float64Array, i0: number, d: number, n: number, tFull: number): number {
  const f = Math.floor(d);
  const i = (i0 + f) % n, j = (i0 + f + 1) % n;
  const wrap = (k: number) => (i0 + k >= n ? tFull : 0);
  const a = t[i] + wrap(f), b = t[j] + wrap(f + 1);
  return a + (b - a) * (d - f);
}

/** Мгновенная боковая нагрузка, g. Угол руля из телеметрии не восстановить, а
 *  радиус, который карт пишет, меряется точно — и вместе со скоростью даёт
 *  перегрузку без акселерометра: a = v²·κ. */
const latAt = (v: number, kap: number) =>
  (isFinite(kap) ? ((v / 3.6) ** 2 * Math.abs(kap)) / 9.81 : NaN);

/**
 * Разгон внутри окна: от низшей точки скорости до пика.
 *
 * Пик ищется первым, минимум — до него. Наоборот нельзя: окно тянется от апекса
 * до апекса, и самая низкая скорость в нём — это следующий поворот, а не выход
 * из текущего.
 *
 * Отдельно ищется самый длинный кусок разгона, который карт едет прямо, — по
 * нему и меряется мотор. Отсекать просто «до первой нагрузки» нельзя: разгон
 * начинается на апексе, где нагрузка максимальная, и такая отсечка срабатывала
 * бы мгновенно, объявляя браком даже чистые прямые. Прямой кусок начинается
 * там, где карт распрямился, и кончается там, где входит в следующую дугу, —
 * а на трассе, где сразу за прямой идёт быстрый поворот, это единственный
 * способ не выбросить участок целиком вместе с его честным началом.
 */
function pullWindow(
  v: Float64Array, kap: Float64Array, i0: number, len: number, n: number,
): { min: number; peak: number; vMin: number; vPeak: number; sLo: number; sHi: number } {
  let peak = 0, hi = -Infinity;
  for (let d = 0; d <= len; d++) {
    const x = v[(i0 + d) % n];
    if (x > hi) { hi = x; peak = d; }
  }
  let min = 0, lo = Infinity;
  for (let d = 0; d <= peak; d++) {
    const x = v[(i0 + d) % n];
    if (x < lo) { lo = x; min = d; }
  }

  // Самый длинный участок низкой нагрузки между минимумом и пиком. Три отсчёта
  // подряд, а не один: одиночный выброс гироскопа не должен рвать прямую надвое.
  let bestA = -1, bestB = -1, curA = -1, over = 0;
  const close = (end: number) => {
    if (curA >= 0 && end - curA > bestB - bestA) { bestA = curA; bestB = end; }
    curA = -1;
  };
  for (let d = min; d <= peak; d++) {
    const i = (i0 + d) % n;
    const g = latAt(v[i], kap[i]);
    if (isFinite(g) && g > CLEAN_G) {
      if (++over >= 3) close(d - over);
      continue;
    }
    over = 0;
    if (curA < 0) curA = d;
  }
  close(peak);

  return {
    min, peak, vMin: lo, vPeak: hi,
    sLo: bestA >= 0 ? v[(i0 + bestA) % n] : NaN,
    sHi: bestB >= 0 ? v[(i0 + bestB) % n] : NaN,
  };
}

/**
 * Разгонные ворота по всем участкам.
 *
 * @param drivers участники сравнения — те же, что в таблицах: заезд целиком или
 *   копия, привязанная к одному кругу. Ворота считаются по всем сразу, иначе
 *   колонки мерили бы разные диапазоны скоростей и не сравнивались бы между собой.
 */
export function buildPulls(
  drivers: DriverResult[],
  corners: Corner[],
  grid: Float64Array,
  trackLength: number,
): PullReport {
  const sections = buildSections(corners, trackLength);
  const n = grid.length;
  const step = grid[1] - grid[0];

  const rows: PullRow[] = sections.map(sec => {
    const iA = idxOf(grid, sec.sStart), iB = idxOf(grid, sec.sEnd);
    const len = ringLen(iA, iB, n);
    const none = (skip: string): PullRow =>
      ({ section: sec, gate: null, skip, latG: NaN, latSpread: NaN, clean: false, cells: [] });
    if (len < 8) return none('слишком короткий');

    // Диапазон, который реально проезжают все: снизу — самая высокая низшая точка
    // скорости, сверху — самая низкая пиковая. Ниже нижней границы кто-то уже
    // едет быстрее и разгон не с чего начинать, выше верхней кто-то не доезжает.
    let vLo = -Infinity, vHi = Infinity;
    let sLo = -Infinity, sHi = Infinity;
    let enough = true;
    for (const d of drivers) {
      const mins: number[] = [], peaks: number[] = [];
      const straightLo: number[] = [], straightHi: number[] = [];
      for (const tr of d.traces) {
        const w = pullWindow(tr.v, tr.kap, iA, len, n);
        mins.push(w.vMin); peaks.push(w.vPeak);
        if (isFinite(w.sLo)) { straightLo.push(w.sLo); straightHi.push(w.sHi); }
      }
      if (!mins.length) { enough = false; break; }
      // Нижняя граница — почти максимум минимумов: круги, где карт вообще не
      // опустился до ворот, из замера выпадают, и брать медиану значило бы
      // потерять половину. Верхняя — наоборот, почти минимум пиков.
      vLo = Math.max(vLo, quantile(mins, 0.95));
      vHi = Math.min(vHi, quantile(peaks, 0.1));
      if (straightLo.length) {
        sLo = Math.max(sLo, med(straightLo));
        sHi = Math.min(sHi, med(straightHi));
      }
    }
    if (!enough) return none('нет кругов');

    // Сначала пробуем померить только прямую часть разгона: так участок с
    // быстрой дугой в конце не уходит в брак целиком вместе с честным началом.
    // Не влезло — меряем разгон целиком и помечаем, что тягу он судит вместе с
    // траекторией.
    const clean0 = {
      vLo: Math.ceil(Math.max(vLo, sLo)) + MARGIN,
      vHi: Math.floor(Math.min(vHi, sHi)) - MARGIN,
    };
    const full = { vLo: Math.ceil(vLo) + MARGIN, vHi: Math.floor(vHi) - MARGIN };
    const capped = clean0.vHi - clean0.vLo >= MIN_SPAN;
    if (!capped && full.vHi - full.vLo < MIN_SPAN) {
      return none(`общий диапазон всего ${Math.max(0, full.vHi - full.vLo)} км/ч`);
    }
    const gate: Gate = capped ? clean0 : full;

    const cells: PullCell[] = drivers.map(d => {
      const laps: PullLap[] = [];
      for (const tr of d.traces) {
        const tFull = tr.t[n - 1] + (tr.t[n - 1] - tr.t[n - 2]);
        const w = pullWindow(tr.v, tr.kap, iA, len, n);
        const dLo = crossUp(tr.v, iA, w.min, w.peak, gate.vLo, n);
        if (!isFinite(dLo)) continue;
        const dHi = crossUp(tr.v, iA, Math.ceil(dLo), w.peak, gate.vHi, n);
        if (!isFinite(dHi) || dHi <= dLo) continue;
        let gSum = 0, gCnt = 0;
        for (let k = Math.ceil(dLo); k <= Math.floor(dHi); k++) {
          const g = latAt(tr.v[(iA + k) % n], tr.kap[(iA + k) % n]);
          if (!isFinite(g)) continue;
          gSum += g; gCnt++;
        }
        laps.push({
          lapIndex: tr.lapIndex,
          dist: (dHi - dLo) * step,
          time: timeAt(tr.t, iA, dHi, n, tFull) - timeAt(tr.t, iA, dLo, n, tFull),
          latG: gCnt ? gSum / gCnt : NaN,
        });
      }
      const ds = laps.map(l => l.dist);
      const sd = mad(ds);
      return {
        driverId: d.id,
        dist: med(ds), time: med(laps.map(l => l.time)),
        // p20, а не p10: край распределения из двух-трёх десятков кругов сам по
        // себе шумный, и чем ближе к краю, тем больше в оценку попадает удачного
        // стечения обстоятельств вместо возможностей карта.
        distBest: quantile(ds, 0.2), timeBest: quantile(laps.map(l => l.time), 0.2),
        latG: med(laps.map(l => l.latG).filter(isFinite)),
        // Погрешность медианы, а не разброс по кругам: сравниваются именно медианы.
        se: laps.length > 1 ? (sd * 1.25) / Math.sqrt(laps.length) : NaN,
        n: laps.length, nTotal: d.traces.length,
        laps,
      };
    });

    const gs = cells.map(c => c.latG).filter(isFinite);
    const latG = med(gs);
    const latSpread = gs.length > 1 ? Math.max(...gs) - Math.min(...gs) : 0;
    // Чистым участок считается, только если ворота удалось удержать в пределах
    // прямой части разгона: иначе в дистанцию вошла дуга.
    const clean = capped && isFinite(latG) && latG < CLEAN_G && latSpread <= LOAD_GAP;

    // Участок идёт в зачёт только если померился у всех: иначе сумма по колонкам
    // складывалась бы из разного набора участков.
    if (cells.some(c => !isFinite(c.dist))) {
      return { section: sec, gate, latG, latSpread, clean, cells, skip: 'разгон уложился не у всех' };
    }
    // Половина кругов, выпавшая из ворот, — это уже не выборка, а остаток.
    if (cells.some(c => c.n < Math.max(2, c.nTotal / 2))) {
      return { section: sec, gate, latG, latSpread, clean, cells, skip: 'в ворота уложилось мало кругов' };
    }
    return { section: sec, gate, latG, latSpread, clean, cells };
  });

  const good = rows.filter(r => r.gate && !r.skip);
  // Итог считается по тем же участкам, что и вердикт. Иначе на одном экране
  // оказываются две разные цифры: «тяга одинаковая» по чистым участкам и
  // «+1.5 м» по всем — и непонятно, которой верить.
  const cleanRows = good.filter(r => r.clean);
  const scoredRows = cleanRows.length >= 2 ? cleanRows : good;
  const totals = drivers.map((d, k) => {
    let dist = 0, distBest = 0, varSum = 0, nMin = Infinity;
    for (const r of scoredRows) {
      const c = r.cells[k];
      dist += c.dist;
      distBest += c.distBest;
      if (isFinite(c.se)) varSum += c.se ** 2;
      nMin = Math.min(nMin, c.n);
    }
    return {
      driverId: d.id, dist, distBest,
      se: Math.sqrt(varSum),
      n: isFinite(nMin) ? nMin : 0,
    };
  });

  return {
    rows, totals,
    used: good.length,
    cleanUsed: cleanRows.length,
    scope: cleanRows.length >= 2 ? 'clean' : 'all',
    scored: scoredRows.length,
  };
}

export type VerdictKind = 'none' | 'top' | 'bottom' | 'all' | 'mixed';

export interface Verdict {
  kind: VerdictKind;
  /** отставание в % дистанции разгона, усреднённое по участкам */
  pct: number;
  /** Ответ одной фразой: мотор или не мотор. Всё остальное — обоснование. */
  title: string;
  /** Почему так решили, с числами, но без терминов. */
  why: string;
  /** Что с этим делать: куда смотреть механику. Пусто — делать нечего. */
  action: string;
  /** оговорка о качестве участков, если она нужна */
  note?: string;
  /** Отставание по каждым воротам, от медленных к быстрым. Вывод про мотор
   *  держится не на величине, а на этом ряде: интерфейс обязан показать сам ряд,
   *  иначе пилоту приходится добывать его из таблицы вручную. */
  points: { mid: number; rel: number; err: number; label: string }[];
}

/**
 * Что означает форма отставания.
 *
 * Одно число «медленнее на 6%» не отвечает на вопрос, из-за чего. А вот
 * распределение по диапазонам скоростей отвечает: участки делятся пополам по
 * середине их ворот, и сравнивается отставание на медленных и быстрых.
 */
export function verdict(
  rep: PullReport, refId: string, driverId: string, mode: PullMode = 'median',
): Verdict {
  const D = (c: PullCell) => (mode === 'best' ? c.distBest : c.dist);
  const all = rep.rows
    .filter(r => r.gate && !r.skip)
    .map(r => {
      const a = r.cells.find(c => c.driverId === driverId)!;
      const b = r.cells.find(c => c.driverId === refId)!;
      return {
        mid: (r.gate!.vLo + r.gate!.vHi) / 2,
        label: r.section.label,
        clean: r.clean,
        latG: r.latG, latSpread: r.latSpread,
        rel: (D(a) - D(b)) / D(b),
        // Погрешность самого отставания, в тех же долях: без неё нельзя отличить
        // настоящий наклон ряда от того, что просто по-разному легло по кругам.
        err: ((isFinite(a.se) ? a.se : 0) + (isFinite(b.se) ? b.se : 0)) / D(b),
        // Значимой считаем разницу, которая крупнее суммарной погрешности медиан.
        sig: Math.abs(D(a) - D(b)) > (isFinite(a.se) ? a.se : 0) + (isFinite(b.se) ? b.se : 0),
      };
    });
  if (!all.length) {
    return {
      kind: 'none', pct: NaN, points: [],
      title: 'Мерить нечего',
      why: 'Ни на одном участке у сравниваемых заездов нет общего диапазона скоростей.',
      action: '',
    };
  }

  // Про мотор судим по участкам с низкой боковой нагрузкой. Если таких нет,
  // считаем по всем, но говорим, что в цифру вошла и работа в повороте.
  const clean = all.filter(p => p.clean);
  const pts = clean.length >= 2 ? clean : all;
  const note = clean.length >= 2 ? undefined : (() => {
    const dirty = all.filter(p => !p.clean);
    // Две разные беды, и лечатся они по-разному, поэтому и говорить о них надо
    // раздельно: либо прямых нет ни у кого, либо пилоты по-разному проходят выход.
    const unequal = dirty.filter(p => p.latSpread > LOAD_GAP).length;
    const heavy = dirty.filter(p => p.latG >= CLEAN_G).length;
    if (unequal >= heavy && unequal > 0) {
      return 'На выходе участники нагружают карт по-разному: один уже едет прямо, другой ещё тянет дугу. '
        + 'Разгон у них ограничен разным — у одного мотором, у другого сцеплением шин, — поэтому в цифру '
        + 'входит траектория, а не только тяга.';
    }
    return 'На этой трассе карт нигде не едет прямо достаточно долго: в разгон входит выход из поворота, '
      + 'поэтому в цифру попадает и траектория, а не только тяга.';
  })();

  const pct = 100 * pts.reduce((s, p) => s + p.rel, 0) / pts.length;
  const points = [...pts].sort((x, y) => x.mid - y.mid)
    .map(p => ({ mid: p.mid, rel: 100 * p.rel, err: 100 * p.err, label: p.label }));
  const base = { pct, points, note };

  const sig = pts.filter(p => p.sig);
  if (!sig.length) {
    return {
      ...base, kind: 'none',
      title: 'Карты едут одинаково',
      why: 'Разница в разгоне меньше, чем карт расходится сам с собой от круга к кругу.',
      action: '',
    };
  }
  if (pct < 0) {
    return {
      ...base, kind: 'mixed',
      title: 'Этот карт разгоняется лучше',
      why: `Он проходит те же ворота короче в среднем на ${Math.abs(pct).toFixed(1)}%.`,
      action: '',
    };
  }

  if (points.length < 2) {
    return {
      ...base, kind: 'mixed',
      title: 'Причину назвать нельзя',
      why: `Карт медленнее на ${pct.toFixed(1)}%, но годный участок всего один. `
        + 'Отличить мотор от массы можно только сравнив отставание на разных скоростях.',
      action: 'Нужен заезд на трассе, где есть хотя бы два разгона в разном диапазоне скоростей.',
    };
  }

  // Вывод держится на наклоне ряда, а не на том, в какую половину попал участок.
  // Прежняя нарезка «медленные / быстрые» объявляла отставание одинаковым, даже
  // когда ряд явно шёл вниз, — текст расходился с числами прямо под ним.
  const a = points[0], b = points[points.length - 1];
  const change = b.rel - a.rel;
  const err = a.err + b.err;
  const pair = `${a.rel.toFixed(1)}% на ${a.mid.toFixed(0)} км/ч и ${b.rel.toFixed(1)}% на ${b.mid.toFixed(0)} км/ч`;

  if (change > err) {
    return {
      ...base, kind: 'top',
      title: 'Мотор или лишнее сопротивление',
      why: `Чем быстрее едет карт, тем сильнее он отстаёт — ${pair}. Так выглядит нехватка мощности: `
        + 'внизу тяги хватает обоим, а наверху уже нет. Точно так же выглядит и лишнее трение — '
        + 'по одному разгону их не разделить.',
      action: 'Проверять мотор (выхлоп, зажигание, компрессию) и заодно тормоз и подшипники — '
        + 'притирающий тормоз даёт ту же картину.',
    };
  }
  if (change < -err) {
    return {
      ...base, kind: 'bottom',
      title: 'Проваливаются низы',
      why: `Карт отстаёт на малой скорости и догоняет на большой — ${pair}. Мощности ему хватает, `
        + 'не хватает подхвата сразу после поворота.',
      action: 'Проверять карбюратор и сцепление. Если техника в порядке — значит пилот позже открывает '
        + 'газ на выходе, и это уже не про карт.',
    };
  }
  return {
    ...base, kind: 'all',
    title: 'Мотор ни при чём',
    why: `Отставание не зависит от скорости: ${pair}, и разница между ними меньше погрешности замера `
      + `(±${err.toFixed(1)}%). Слабый мотор так себя не ведёт — он отставал бы тем сильнее, чем быстрее `
      + 'едет карт.',
    action: 'Искать то, что мешает одинаково на любой скорости: вес пилота или лишнюю массу на карте.',
  };
}

/**
 * Шумовой пол: делим круги пилота пополам и меряем ту же метрику между
 * половинами. Разница между двумя половинами одного и того же заезда на одном и
 * том же карте — это чистый шум метода. Всё, что мельче, объявлять разницей
 * между картами нельзя, и интерфейс обязан это показывать рядом с ответом.
 *
 * @returns расхождение половин в % (NaN — кругов слишком мало)
 */
export function noiseFloor(
  d: DriverResult, corners: Corner[], grid: Float64Array, trackLength: number,
  mode: PullMode = 'median',
): number {
  if (d.traces.length < 8) return NaN;
  const half = d.traces.length >> 1;
  const rep = buildPulls(
    [{ ...d, id: `${d.id}#a`, traces: d.traces.slice(0, half) },
     { ...d, id: `${d.id}#b`, traces: d.traces.slice(half) }],
    corners, grid, trackLength,
  );
  const [a, b] = rep.totals;
  if (!rep.used || !a || !b) return NaN;
  const x = mode === 'best' ? a.distBest : a.dist;
  const y = mode === 'best' ? b.distBest : b.dist;
  if (!x || !y) return NaN;
  return Math.abs(100 * (y - x) / x);
}
