import { useMemo, useState } from 'react';
import type { ViewCtx } from '../App';
import type { DriverResult, LapInfo } from '../../core/pipeline';
import type { Sector } from '../../core/analysis';
import { lapTime, delta, num, plural } from '../format';

interface ZoneStat {
  z: number; name: string;
  best: number; median: number; sd: number;
  onTheTable: number;   // медиана минус собственный лучший — сколько теряется обычно
  inBest: number;       // потеряно в лучшем круге относительно своего лучшего
  hitRate: number;      // доля кругов в пределах 0.05 с от своего лучшего
}

interface Row {
  lapIndex: number; time: number;
  dev: number[];        // отклонение по зонам от медианы пилота
  total: number;
  excluded: boolean;
  suspect: LapInfo['suspect'];
}

interface SectorStat {
  s: Sector;
  best: number; median: number;
  onTheTable: number;   // обычный круг против собственного лучшего в этом секторе
  inBest: number;       // сколько осталось на столе в самом лучшем круге
  hitRate: number;
}

interface DriverConsistency {
  d: DriverResult;
  rows: Row[];          // все круги: и в расчёте, и снятые
  used: number;         // сколько кругов реально участвует
  zones: ZoneStat[];
  sectors: SectorStat[];
  sigma: Float64Array;  // устойчивый разброс по зонам
  scale: number;
  potential: number;      // круг из лучших отдельных зон — оптимистичный потолок
  potentialSec: number;   // круг из лучших секторов — достижимый
  bestLapTime: number;
  medianLapTime: number;
  suspects: number[];   // номера кругов, похожих на помеху и ещё не снятых
}

const med = (x: number[]) => { const s = [...x].sort((a, b) => a - b); return s[s.length >> 1]; };

function analyse(ctx: ViewCtx): DriverConsistency[] {
  const { a } = ctx;
  return a.drivers.map(d => {
    const clean = d.laps.filter(l => l.clean);
    const nz = a.zones.length;
    // Лучший круг заезда: относительно него и считаем, сколько ещё лежит на столе.
    const bestI = clean.reduce((bi, l, i) => (l.time < clean[bi].time ? i : bi), 0);

    const zones: ZoneStat[] = [];
    for (let z = 0; z < nz; z++) {
      const col = d.zoneByLap.map(r => r[z]);
      const best = Math.min(...col);
      const m = med(col);
      const mean = col.reduce((p, q) => p + q, 0) / col.length;
      zones.push({
        z, name: a.zones[z].corner.name,
        best, median: m,
        sd: Math.sqrt(col.reduce((p, q) => p + (q - mean) ** 2, 0) / col.length),
        onTheTable: m - best,
        inBest: col[bestI] - best,
        hitRate: col.filter(v => v <= best + 0.05).length / col.length,
      });
    }

    // Сектор — несколько поворотов подряд. Внутри него компромисс «быстрый вход —
    // испорченный выход» уже оплачен, поэтому собранный из секторов круг достижим,
    // в отличие от суммы лучших одиночных зон.
    const sectors: SectorStat[] = ctx.sectors.map(s => {
      const col = d.zoneByLap.map(r => {
        let t = 0;
        for (let z = s.from; z <= s.to; z++) t += r[z];
        return t;
      });
      const best = Math.min(...col);
      const m = med(col);
      return {
        s, best, median: m,
        onTheTable: m - best,
        inBest: col[bestI] - best,
        hitRate: col.filter(v => v <= best + 0.05).length / col.length,
      };
    });

    const mkDev = (r: ArrayLike<number>) => Array.from({ length: nz }, (_, z) => r[z] - zones[z].median);
    const rows: Row[] = d.zoneByLap.map((r, i) => {
      const dev = mkDev(r);
      return {
        lapIndex: clean[i].index, time: clean[i].time, dev,
        total: dev.reduce((p, q) => p + q, 0),
        excluded: false, suspect: clean[i].suspect,
      };
    });
    // Снятые круги остаются в таблице — иначе их нечем вернуть, да и видно,
    // за что именно они сняты.
    for (const e of d.excludedRows) {
      const dev = mkDev(e.row);
      rows.push({
        lapIndex: e.lapIndex, time: e.time, dev,
        total: dev.reduce((p, q) => p + q, 0),
        excluded: true, suspect: null,
      });
    }
    rows.sort((p, q) => p.lapIndex - q.lapIndex);

    // Шкала — только по кругам в расчёте: снятый круг с большим выбросом
    // иначе сплющил бы все остальные цвета.
    const flat = rows.filter(r => !r.excluded).flatMap(r => r.dev)
      .filter(v => isFinite(v)).map(Math.abs).sort((p, q) => p - q);

    const bestLap = Math.min(...clean.map(l => l.time));

    return {
      d, rows, zones, sectors,
      used: clean.length,
      sigma: d.zoneSigma,
      scale: Math.max(0.02, flat[Math.floor(flat.length * 0.9)] ?? 0.05),
      // Не сумма лучших кусков: она живёт в «зонных» секундах, которые из-за
      // интерполяции по сетке расходятся с отсечками круга на пару сотых.
      // Считаем от реального лучшего круга, вычитая то, что в нём отыгрывается.
      potential: bestLap - zones.reduce((p, q) => p + q.inBest, 0),
      potentialSec: bestLap - sectors.reduce((p, q) => p + q.inBest, 0),
      bestLapTime: bestLap,
      medianLapTime: med(clean.map(l => l.time)),
      suspects: clean.filter(l => l.suspect).map(l => l.index),
    };
  });
}

export function Consistency({ ctx }: { ctx: ViewCtx }) {
  const data = useMemo(() => analyse(ctx), [ctx]);

  return (
    <div className="flex flex-col gap-4">
      <div className="panel p-4">
        <div className="text-[13px] font-medium">Повторяемость по поворотам</div>
        <div className="text-[11px] text-[var(--muted)] leading-relaxed mt-0.5">
          Каждая клетка — отклонение круга от собственной медианы пилота в этой зоне.
          Красное — медленнее обычного, зелёное — быстрее. Ровный столбец значит, что поворот
          отработан на автомате; пёстрый — что каждый раз получается по-разному, и там есть что забрать.
          Клик по номеру круга снимает его со всех расчётов — так убирают круги, испорченные
          трафиком или ошибкой; повторный клик возвращает.
        </div>
      </div>

      {data.map(dc => <DriverBlock key={dc.d.id} dc={dc} ctx={ctx} />)}
    </div>
  );
}

function DriverBlock({ dc, ctx }: { dc: DriverConsistency; ctx: ViewCtx }) {
  const { name, color, exclOf, setExcl, busy } = ctx;
  const [hi, setHi] = useState<{ lap: number; z: number } | null>(null);
  const worst = [...dc.zones].sort((p, q) => q.onTheTable - p.onTheTable);
  // Обе величины — суммы по секторам, а не разности времён круга: медиана круга
  // и сумма медиан секторов — разные вещи (в каждом круге просаживается свой кусок).
  const gap = dc.sectors.reduce((p, x) => p + x.onTheTable, 0);
  const gapFromBest = dc.sectors.reduce((p, x) => p + x.inBest, 0);
  const gapZone = dc.zones.reduce((p, x) => p + x.onTheTable, 0);
  const maxTable = Math.max(...dc.zones.map(z => z.onTheTable), 0.001);
  const inPlay = dc.rows.filter(r => !r.excluded);
  const bestLapIndex = inPlay.reduce((p, q) => (q.time < p.time ? q : p), inPlay[0]).lapIndex;
  const maxTotal = Math.max(...inPlay.map(l => Math.abs(l.total)), 0.001);
  const cut = exclOf(dc.d);
  // 102 — колонка круга, 32 клетка + 3 зазор, 8 + 54 — полоса «круг целиком»
  // клетки секторов раздвинуты: видно, из каких кусков собирается достижимый круг
  const SEP = 9;
  const secEnd = new Set(dc.sectors.map(x => x.s.to));
  const gridW = 102 + 3 + dc.zones.length * 35 - 3 + (dc.sectors.length - 1) * SEP + 8 + 54;
  const nCut = dc.rows.filter(r => r.excluded).length;

  const toggle = (lapIndex: number) => {
    if (busy) return;
    setExcl(dc.d, cut.includes(lapIndex) ? cut.filter(i => i !== lapIndex) : [...cut, lapIndex]);
  };

  return (
    <div className="panel p-4">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: color(dc.d) }} />
        <span className="text-[13px] font-medium">{name(dc.d)}</span>
        <span className="text-[11px] text-[var(--muted)] num">
          {dc.used} {plural(dc.used, 'круг', 'круга', 'кругов')} в расчёте · разброс ±{dc.d.stats.sd.toFixed(3)} с
          {nCut > 0 && <span className="text-[#ffd9a0]"> · {nCut} снято</span>}
        </span>
        {nCut > 0 && (
          <button disabled={busy} onClick={() => setExcl(dc.d, [])}
            className="text-[11px] px-2 py-0.5 rounded border border-[var(--line)] text-[var(--muted)]
              hover:text-[var(--text)] hover:bg-[var(--panel-2)] transition disabled:opacity-40">
            вернуть все
          </button>
        )}
      </div>

      {dc.suspects.length > 0 && (
        <div className="rounded-lg px-3 py-2 mb-3 flex items-center gap-3 flex-wrap text-[12px]"
          style={{ background: 'rgba(255,146,43,0.09)' }}>
          <span className="text-[#ffc078]">⚠</span>
          <span className="leading-snug">
            Похоже на помеху: {dc.suspects.length}{' '}
            {plural(dc.suspects.length, 'круг', 'круга', 'кругов')} —{' '}
            <span className="num">{dc.suspects.map(i => `#${i}`).join(', ')}</span>.
            Такой круг обычен везде, кроме одной зоны, где он резко медленнее: это чаще упёршийся
            впереди карт, чем ошибка пилота.
          </span>
          <button disabled={busy}
            onClick={() => setExcl(dc.d, [...new Set([...cut, ...dc.suspects])])}
            className="ml-auto text-[11px] px-2.5 py-1 rounded border border-[#5a4a2b] bg-[#191510]
              text-[#ffd9a0] hover:bg-[#221c12] transition disabled:opacity-40">
            снять их
          </button>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[auto_1fr] items-start">
        <div className="overflow-x-auto">
          {/* ширина ровно по сетке: иначе длинная подпись снизу растягивает колонку
              и между картой и правой панелью зияет пустота */}
          <div style={{ width: gridW }}>
            {dc.sectors.length > 1 && (
              <div className="flex gap-[3px]" style={{ paddingLeft: 106 }}>
                {dc.sectors.map(x => {
                  const n = x.s.to - x.s.from + 1;
                  return (
                    <div key={x.s.id}
                      className="text-[10px] text-[var(--muted-2)] text-center num rounded-t-[3px]"
                      style={{
                        width: n * 32 + (n - 1) * 3,
                        marginRight: x.s.id === dc.sectors.length ? 0 : SEP,
                        background: 'rgba(255,255,255,0.035)',
                      }}>
                      {x.s.name}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex gap-[3px] mb-1" style={{ paddingLeft: 106 }}>
              {dc.zones.map(z => (
                <div key={z.z} className="text-[10px] text-[var(--muted-2)] text-center num"
                  style={{ width: 32, marginRight: secEnd.has(z.z) && z.z !== dc.zones.length - 1 ? SEP : 0 }}>
                  {z.name}
                </div>
              ))}
            </div>

            {dc.rows.map(l => {
              const isBest = !l.excluded && l.lapIndex === bestLapIndex;
              return (
                <div key={l.lapIndex} className="flex gap-[3px] items-center mb-[3px]"
                  style={{ opacity: l.excluded ? 0.4 : 1 }}>
                  <button
                    onClick={() => toggle(l.lapIndex)}
                    disabled={busy}
                    title={l.excluded
                      ? `Круг ${l.lapIndex} снят с расчётов — вернуть`
                      : l.suspect
                        ? `Круг ${l.lapIndex}: похоже на помеху в ${dc.zones[l.suspect.zone].name} `
                          + `(+${l.suspect.loss.toFixed(3)} с к обычному). Снять с расчётов`
                        : `Снять круг ${l.lapIndex} со всех расчётов`}
                    className="flex items-center justify-end gap-1 rounded px-1 py-0.5 -my-0.5
                      hover:bg-[var(--panel-2)] transition disabled:cursor-default"
                    style={{ width: 102 }}
                  >
                    <span className="w-3 text-[9px] leading-none"
                      style={{ color: l.suspect && !l.excluded ? '#ffc078' : 'var(--good)' }}>
                      {l.excluded ? '' : isBest ? '★' : l.suspect ? '⚠' : ''}
                    </span>
                    <span className="text-[10px] text-[var(--muted-2)] num">#{l.lapIndex}</span>
                    <span className="text-[10px] num"
                      style={{
                        color: isBest ? 'var(--good)' : 'var(--muted)',
                        textDecoration: l.excluded ? 'line-through' : undefined,
                      }}>
                      {l.time.toFixed(2)}
                    </span>
                    <span className="text-[10px] w-3 leading-none"
                      style={{ color: l.excluded ? '#ffd9a0' : 'transparent' }}>↺</span>
                  </button>

                  {l.dev.map((v, zi) => {
                    const t = Math.max(-1, Math.min(1, v / dc.scale));
                    const outlier = !l.excluded && Math.abs(v) > 2 * dc.sigma[zi] && Math.abs(v) > 0.05;
                    return (
                      <div key={zi}
                        onMouseEnter={() => setHi({ lap: l.lapIndex, z: zi })}
                        onMouseLeave={() => setHi(null)}
                        title={`Круг ${l.lapIndex} · ${dc.zones[zi].name} · ${delta(v)} с к своей медиане`}
                        className="rounded-[3px] cursor-default transition-transform hover:scale-110"
                        style={{
                          width: 32, height: 15,
                          marginRight: secEnd.has(zi) && zi !== l.dev.length - 1 ? SEP : 0,
                          background: t > 0
                            ? `rgba(255,107,107,${0.12 + 0.72 * t})`
                            : `rgba(81,207,102,${0.12 + 0.72 * -t})`,
                          outline: outlier ? '1px solid rgba(255,255,255,0.45)' : undefined,
                          outlineOffset: -1,
                        }} />
                    );
                  })}

                  <div className="ml-2 relative" style={{ width: 54, height: 15 }}>
                    <div className="absolute top-0 bottom-0 rounded-[2px]" style={{
                      left: l.total >= 0 ? '50%' : undefined,
                      right: l.total < 0 ? '50%' : undefined,
                      width: `${Math.min(50, (Math.abs(l.total) / maxTotal) * 50)}%`,
                      background: l.total >= 0 ? 'rgba(255,107,107,0.5)' : 'rgba(81,207,102,0.5)',
                    }} />
                    <div className="absolute inset-y-0 left-1/2 w-px bg-[var(--line)]" />
                  </div>
                </div>
              );
            })}

            <div className="text-[10px] text-[var(--muted-2)] mt-2 num leading-relaxed" style={{ paddingLeft: 106 }}>
              шкала ±{dc.scale.toFixed(3)} с · белая рамка — клетка, где отклонение вдвое больше
              обычного разброса · полоса справа — круг целиком · клик по номеру снимает круг с расчётов
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 min-w-[280px]">
          <div className="rounded-lg p-3" style={{ background: 'rgba(255,212,59,0.07)' }}>
            <div className="text-[11px] text-[var(--muted)] mb-1">Достижимый круг</div>
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="num text-xl font-semibold">{lapTime(dc.potentialSec)}</span>
              <span className="num text-[12px] text-[var(--muted)]">
                из собственных лучших секторов
              </span>
            </div>
            <div className="text-[12px] leading-relaxed mt-2 text-[var(--muted)]">
              Это лучший реальный круг <span className="num text-[var(--text)]">{lapTime(dc.bestLapTime)}</span>,
              в котором каждый сектор проехан как собственный лучший: даже в нём
              осталось <span className="num text-[var(--text)]">{gapFromBest.toFixed(3)} с</span>.
              В обычном круге секторы теряют <span className="num text-[var(--text)]">{gap.toFixed(3)} с</span>.
            </div>
            <div className="text-[10px] text-[var(--muted-2)] leading-relaxed mt-2">
              Сектор — несколько поворотов подряд. Быстрый вход в один поворот часто оплачивается
              выходом и следующим поворотом, поэтому сумма лучших <i>отдельных</i> поворотов —{' '}
              <span className="num">{lapTime(dc.potential)}</span> — в одном проезде обычно недостижима:
              она складывает то, что вместе не едется. Круг из лучших секторов такую сделку уже учитывает.
            </div>
          </div>

          {dc.sectors.length > 1 && (
            <div>
              <div className="text-[11px] text-[var(--muted)] mb-1.5">Секторы</div>
              <div className="scroll-x">
              <table className="w-full min-w-[360px] text-[11px] num">
                <thead>
                  <tr className="text-[10px] text-[var(--muted-2)]">
                    <th className="text-left font-normal pb-1">сект.</th>
                    <th className="text-left font-normal pb-1">повороты</th>
                    <th className="text-right font-normal pb-1">лучший</th>
                    <th className="text-right font-normal pb-1"
                      title="Насколько обычный проезд сектора медленнее собственного лучшего">
                      обычно
                    </th>
                    <th className="text-right font-normal pb-1"
                      title="Сколько осталось на столе в самом лучшем круге заезда">
                      в лучшем круге
                    </th>
                    <th className="text-right font-normal pb-1">попаданий</th>
                  </tr>
                </thead>
                <tbody>
                  {dc.sectors.map(x => (
                    <tr key={x.s.id} className="border-t border-[var(--line-soft)]">
                      <td className="py-1 font-medium">{x.s.name}</td>
                      <td className="py-1 text-[var(--muted)]">{x.s.label}</td>
                      <td className="py-1 text-right">{x.best.toFixed(3)}</td>
                      <td className="py-1 text-right">+{x.onTheTable.toFixed(3)}</td>
                      <td className="py-1 text-right"
                        style={{ color: x.inBest < 0.02 ? 'var(--good)' : 'var(--text)' }}>
                        +{x.inBest.toFixed(3)}
                      </td>
                      <td className="py-1 text-right"
                        style={{ color: x.hitRate < 0.15 ? 'var(--bad)' : x.hitRate > 0.35 ? 'var(--good)' : 'var(--muted)' }}>
                        {num(x.hitRate * 100, 0)}%
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-[var(--line)] font-medium">
                    <td className="py-1" colSpan={2}>итого</td>
                    <td className="py-1 text-right text-[var(--muted-2)]">—</td>
                    <td className="py-1 text-right">+{gap.toFixed(3)}</td>
                    <td className="py-1 text-right">+{gapFromBest.toFixed(3)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
              </div>
              <div className="text-[10px] text-[var(--muted-2)] mt-1.5 leading-relaxed">
                Две колонки отвечают на разные вопросы. «Обычно» — сколько сектор теряет
                в рядовом круге; сумма этих потерь и есть запас обычного круга.
                «В лучшем круге» — что осталось несобранным даже в лучшем проезде: там
                удачные секторы уже случились, поэтому чисел почти нет, а весь остаток
                собран в одном-двух местах. Сектор целиком повторяем куда хуже отдельного
                поворота — потому достижимый круг и честнее суммы лучших зон.
              </div>
            </div>
          )}

          <div>
            <div className="text-[11px] text-[var(--muted)] mb-1.5">
              Где теряется больше всего относительно себя же
            </div>
            <table className="w-full text-[11px] num">
              <thead>
                <tr className="text-[10px] text-[var(--muted-2)]">
                  <th className="text-left font-normal pb-1">пов.</th>
                  <th className="text-right font-normal pb-1">на столе</th>
                  <th className="text-right font-normal pb-1"
                    title="Насколько по-разному получается этот поворот от круга к кругу">разброс</th>
                  <th className="text-right font-normal pb-1">попаданий</th>
                </tr>
              </thead>
              <tbody>
                {worst.map(z => (
                  <tr key={z.z}
                    className={`border-t border-[var(--line-soft)] ${hi?.z === z.z ? 'bg-[var(--panel-2)]' : ''}`}
                    onMouseEnter={() => setHi({ lap: -1, z: z.z })}
                    onMouseLeave={() => setHi(null)}>
                    <td className="py-1">{z.name}</td>
                    <td className="py-1 text-right relative">
                      <span className="absolute inset-y-[3px] right-0 rounded-[2px] opacity-20"
                        style={{ width: `${(z.onTheTable / maxTable) * 100}%`, background: 'var(--bad)' }} />
                      <span className="relative">{z.onTheTable.toFixed(3)} с</span>
                    </td>
                    <td className="py-1 text-right text-[var(--muted)]">±{z.sd.toFixed(3)}</td>
                    <td className="py-1 text-right"
                      style={{ color: z.hitRate < 0.15 ? 'var(--bad)' : z.hitRate > 0.35 ? 'var(--good)' : 'var(--muted)' }}>
                      {num(z.hitRate * 100, 0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-[10px] text-[var(--muted-2)] mt-1.5 leading-relaxed">
              «На столе» — насколько обычный круг медленнее собственного лучшего в этой зоне.
              «Попаданий» — в скольких кругах пилот приблизился к своему лучшему ближе 0.05 с.
              Низкий процент при большом разбросе значит, что поворот получается редко и случайно.
            </div>
          </div>

          <Verdict dc={dc} worst={worst} gap={gapZone} />
        </div>
      </div>
    </div>
  );
}

/** gap здесь — запас по отдельным зонам: резервы ниже тоже зонные, их надо мерить одной линейкой. */
function Verdict({ dc, worst, gap }: { dc: DriverConsistency; worst: ZoneStat[]; gap: number }) {
  const top = worst.slice(0, 3).filter(z => z.onTheTable > 0.02);
  const share = top.reduce((p, q) => p + q.onTheTable, 0) / (gap || 1);
  const steady = dc.zones.filter(z => z.hitRate > 0.35).map(z => z.name);

  return (
    <div className="rounded-lg p-3 text-[12px] leading-relaxed" style={{ background: 'rgba(255,255,255,0.03)' }}>
      {top.length > 0 && (
        <p>
          Крупнейшие резервы — {top.map(z => z.name).join(', ')}: вместе{' '}
          <span className="num">{top.reduce((p, q) => p + q.onTheTable, 0).toFixed(3)} с</span> из{' '}
          <span className="num">{gap.toFixed(3)} с</span>.{' '}
          {share > 0.5
            ? 'Это больше половины всего запаса — работать стоит прежде всего с ними.'
            : 'Заметного перекоса нет: время теряется понемногу по всему кругу, а не в паре мест.'}
        </p>
      )}
      {steady.length > 0 && (
        <p className="mt-1.5 text-[var(--muted)]">
          Стабильно получаются: {steady.join(', ')} — здесь запаса почти нет.
        </p>
      )}
      {dc.d.stats.drift < -0.12 && (
        <p className="mt-1.5 text-[var(--muted)]">
          По ходу стинта пилот разгонялся, поэтому ранние круги тянут медиану вверх —
          часть «потенциала» он бы забрал и без работы над техникой.
        </p>
      )}
    </div>
  );
}
