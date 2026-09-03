/**
 * Разгон на прямых — оценка тяги карта отдельно от пилота.
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
 * Пороги не заданы числом, а выводятся из самих данных по каждой прямой: карт на
 * 437 м может нигде не доехать до 60 км/ч, а на длинной трассе 60 будет уже
 * далеко в разгоне. Побочный эффект полезен: медленная прямая меряет низы мотора,
 * длинная — верхи, и по тому, где именно отстаёт карт, различаются причины.
 */

import type { Corner } from './track';
import type { DriverResult } from './pipeline';

export interface Straight {
  id: number;
  label: string;       // «T3 → T4»
  sStart: number;      // конец предыдущего поворота, м от старт/финиша
  sEnd: number;        // начало следующего
  length: number;      // м
}

export interface Gate { vLo: number; vHi: number }

export interface PullLap {
  lapIndex: number;
  dist: number;        // м между воротами
  time: number;        // с между воротами
}

export interface PullCell {
  driverId: string;
  /** медиана дистанции разгона по кругам, м (NaN — ни один круг не прошёл ворота) */
  dist: number;
  time: number;
  /** лучшие разгоны, p10 по кругам, м. Медиана мерит «карт и как его везли»,
   *  лучшие — что карт может, когда пилот в полном газу с самого выхода.
   *  Разрыв, который держится и там и там, объясняется картом, а не манерой. */
  distBest: number;
  timeBest: number;
  /** оценка погрешности медианы, м — по ней видно, значима ли разница */
  se: number;
  n: number;
  laps: PullLap[];
}

export interface PullRow {
  straight: Straight;
  /** null — общего диапазона скоростей на этой прямой нет */
  gate: Gate | null;
  /** почему прямая не годится */
  skip?: string;
  cells: PullCell[];
}

export interface PullReport {
  rows: PullRow[];
  /** сумма дистанций разгона по всем пригодным прямым */
  totals: { driverId: string; dist: number; distBest: number; se: number; n: number }[];
  /** сколько прямых удалось померить */
  used: number;
}

/** Минимальная ширина ворот. Уже 5 км/ч — и шум GPS-скорости съедает измерение. */
const MIN_SPAN = 5;

/** Запас от краёв диапазона: у самых границ пересечение ловится на шуме. */
const MARGIN = 1;

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

/** Прямые — промежутки между поворотами. Свойство трассы, как и сами повороты. */
export function buildStraights(corners: Corner[], length: number): Straight[] {
  const n = corners.length;
  if (n < 2) return [];
  return corners.map((c, i) => {
    const next = corners[(i + 1) % n];
    let len = next.sStart - c.sEnd;
    if (len < 0) len += length;
    return {
      id: i + 1,
      label: `${c.name} → ${next.name}`,
      sStart: c.sEnd, sEnd: next.sStart, length: len,
    };
  });
}

const idxOf = (grid: Float64Array, s: number) => {
  const step = grid[1] - grid[0];
  const n = grid.length;
  return ((Math.round(s / step) % n) + n) % n;
};

/**
 * Первое пересечение скоростью порога, в дробных шагах сетки от начала окна.
 * Дробная часть нужна: сетка в 1 м, а вся разница между картами — единицы метров,
 * округление до целого шага съело бы её заметную часть.
 */
function crossAt(
  v: Float64Array, i0: number, from: number, len: number, target: number, n: number,
): number {
  for (let d = from; d <= len; d++) {
    const i = (i0 + d) % n;
    if (v[i] < target) continue;
    if (d === from) return d;                       // уже выше порога на старте окна
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

/**
 * Разгонные ворота по всем прямым.
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
  const straights = buildStraights(corners, trackLength);
  const n = grid.length;
  const step = grid[1] - grid[0];

  const rows: PullRow[] = straights.map(st => {
    const iA = idxOf(grid, st.sStart), iB = idxOf(grid, st.sEnd);
    const len = ringLen(iA, iB, n);
    if (len < 10) {
      return { straight: st, gate: null, skip: 'слишком короткая', cells: [] };
    }

    // Диапазон, который реально проезжают все: снизу — самая высокая скорость
    // выхода, сверху — самая низкая пиковая. Ниже нижней границы кто-то уже едет
    // быстрее и разгон не с чего начинать, выше верхней кто-то просто не доезжает.
    let vLo = -Infinity, vHi = Infinity;
    let enough = true;
    for (const d of drivers) {
      const starts: number[] = [], peaks: number[] = [];
      for (const tr of d.traces) {
        starts.push(tr.v[iA]);
        let p = -Infinity;
        for (let k = 0; k <= len; k++) p = Math.max(p, tr.v[(iA + k) % n]);
        peaks.push(p);
      }
      if (!starts.length) { enough = false; break; }
      // Не min/max, а квантили: один круг с ранним газом или с трафиком не должен
      // в одиночку решать, годится ли прямая для всех остальных.
      vLo = Math.max(vLo, quantile(starts, 0.9));
      vHi = Math.min(vHi, quantile(peaks, 0.1));
    }
    if (!enough) return { straight: st, gate: null, skip: 'нет кругов', cells: [] };

    const gLo = Math.ceil(vLo) + MARGIN;
    const gHi = Math.floor(vHi) - MARGIN;
    if (gHi - gLo < MIN_SPAN) {
      return {
        straight: st, gate: null, cells: [],
        skip: `общий диапазон всего ${Math.max(0, gHi - gLo)} км/ч`,
      };
    }
    const gate: Gate = { vLo: gLo, vHi: gHi };

    const cells: PullCell[] = drivers.map(d => {
      const laps: PullLap[] = [];
      for (const tr of d.traces) {
        const tFull = tr.t[n - 1] + (tr.t[n - 1] - tr.t[n - 2]);
        const dLo = crossAt(tr.v, iA, 0, len, gate.vLo, n);
        if (!isFinite(dLo)) continue;
        const dHi = crossAt(tr.v, iA, Math.ceil(dLo), len, gate.vHi, n);
        if (!isFinite(dHi) || dHi <= dLo) continue;
        laps.push({
          lapIndex: tr.lapIndex,
          dist: (dHi - dLo) * step,
          time: timeAt(tr.t, iA, dHi, n, tFull) - timeAt(tr.t, iA, dLo, n, tFull),
        });
      }
      const ds = laps.map(l => l.dist);
      const sd = mad(ds);
      return {
        driverId: d.id,
        dist: med(ds), time: med(laps.map(l => l.time)),
        distBest: quantile(ds, 0.1), timeBest: quantile(laps.map(l => l.time), 0.1),
        // Погрешность медианы, а не разброс по кругам: сравниваются именно медианы.
        se: laps.length > 1 ? (sd * 1.25) / Math.sqrt(laps.length) : NaN,
        n: laps.length,
        laps,
      };
    });

    // Прямая идёт в зачёт только если померилась у всех: иначе сумма по колонкам
    // складывалась бы из разного набора прямых.
    if (cells.some(c => !isFinite(c.dist))) {
      return { straight: st, gate, cells, skip: 'разгон уложился не у всех' };
    }
    return { straight: st, gate, cells };
  });

  const good = rows.filter(r => r.gate && !r.skip);
  const totals = drivers.map((d, k) => {
    let dist = 0, distBest = 0, varSum = 0, nMin = Infinity;
    for (const r of good) {
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

  return { rows, totals, used: good.length };
}

/** Медиана — «карт и как его везли», лучшие разгоны — на что карт способен. */
export type PullMode = 'median' | 'best';

export type VerdictKind = 'none' | 'top' | 'bottom' | 'all' | 'mixed';

export interface Verdict {
  kind: VerdictKind;
  /** отставание в % дистанции разгона, усреднённое по прямым */
  pct: number;
  text: string;
}

/**
 * Что означает форма отставания.
 *
 * Одно число «медленнее на 6%» не отвечает на вопрос, из-за чего. А вот
 * распределение по диапазонам скоростей отвечает: прямые делятся пополам по
 * середине их ворот, и сравнивается отставание на медленных и быстрых.
 */
export function verdict(
  rep: PullReport, refId: string, driverId: string, mode: PullMode = 'median',
): Verdict {
  const D = (c: PullCell) => (mode === 'best' ? c.distBest : c.dist);
  const pts = rep.rows
    .filter(r => r.gate && !r.skip)
    .map(r => {
      const a = r.cells.find(c => c.driverId === driverId)!;
      const b = r.cells.find(c => c.driverId === refId)!;
      return {
        mid: (r.gate!.vLo + r.gate!.vHi) / 2,
        rel: (D(a) - D(b)) / D(b),
        // Значимой считаем разницу, которая крупнее суммарной погрешности медиан.
        sig: Math.abs(D(a) - D(b)) > (isFinite(a.se) ? a.se : 0) + (isFinite(b.se) ? b.se : 0),
      };
    });
  if (!pts.length) return { kind: 'none', pct: NaN, text: 'Нет прямых с общим диапазоном скоростей' };

  const pct = 100 * pts.reduce((s, p) => s + p.rel, 0) / pts.length;
  const sig = pts.filter(p => p.sig);
  if (!sig.length) {
    return { kind: 'none', pct, text: 'Разница в пределах разброса по кругам — тяга одинаковая' };
  }

  const mids = pts.map(p => p.mid).sort((x, y) => x - y);
  const cut = mids[mids.length >> 1];
  const low = pts.filter(p => p.mid < cut), high = pts.filter(p => p.mid >= cut);
  const slow = (g: typeof pts) => g.length > 0 && g.some(p => p.sig && p.rel > 0)
    && g.reduce((s, p) => s + p.rel, 0) / g.length > 0.01;
  const lo = slow(low), hi = slow(high);

  if (pct < 0) return { kind: 'mixed', pct, text: 'Разгоняется быстрее опорного' };
  if (lo && hi) return { kind: 'all', pct, text: 'Отстаёт во всём диапазоне — похоже на массу или сопротивление качению (ось, подшипники, тормоза), а не на мотор' };
  if (hi) return { kind: 'top', pct, text: 'Отстаёт только на быстрых прямых — верх мотора' };
  if (lo) return { kind: 'bottom', pct, text: 'Отстаёт только на медленных прямых — низы: карбюратор, сцепление, передатка' };
  return { kind: 'mixed', pct, text: 'Отставание разбросано по прямым без общей картины' };
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
): number {
  if (d.traces.length < 8) return NaN;
  const half = d.traces.length >> 1;
  const rep = buildPulls(
    [{ ...d, id: `${d.id}#a`, traces: d.traces.slice(0, half) },
     { ...d, id: `${d.id}#b`, traces: d.traces.slice(half) }],
    corners, grid, trackLength,
  );
  const [a, b] = rep.totals;
  if (!rep.used || !a?.dist || !b?.dist) return NaN;
  return Math.abs(100 * (b.dist - a.dist) / a.dist);
}
