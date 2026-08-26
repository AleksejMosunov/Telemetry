import { useMemo, useState } from 'react';
import type { ViewCtx } from '../App';
import type { DriverResult } from '../../core/pipeline';
import { lapTime, delta, num } from '../format';

interface ZoneStat {
  z: number; name: string;
  best: number; median: number; sd: number;
  onTheTable: number;   // медиана минус собственный лучший — сколько теряется обычно
  hitRate: number;      // доля кругов в пределах 0.05 с от своего лучшего
}

interface DriverConsistency {
  d: DriverResult;
  laps: { index: number; time: number; row: number[]; total: number }[];
  zones: ZoneStat[];
  scale: number;
  potential: number;    // круг из собственных лучших зон
  bestLapTime: number;
  medianLapTime: number;
}

const med = (x: number[]) => { const s = [...x].sort((a, b) => a - b); return s[s.length >> 1]; };

function analyse(ctx: ViewCtx): DriverConsistency[] {
  const { a } = ctx;
  return a.drivers.map(d => {
    const clean = d.laps.filter(l => l.clean);
    const nz = a.zones.length;

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
        hitRate: col.filter(v => v <= best + 0.05).length / col.length,
      });
    }

    const laps = d.zoneByLap.map((r, i) => {
      const row = Array.from({ length: nz }, (_, z) => r[z] - zones[z].median);
      return {
        index: clean[i].index, time: clean[i].time, row,
        total: row.reduce((p, q) => p + q, 0),
      };
    });

    const flat = laps.flatMap(l => l.row).filter(v => isFinite(v)).map(Math.abs).sort((p, q) => p - q);
    return {
      d, laps, zones,
      scale: Math.max(0.02, flat[Math.floor(flat.length * 0.9)] ?? 0.05),
      potential: zones.reduce((p, q) => p + q.best, 0),
      bestLapTime: Math.min(...clean.map(l => l.time)),
      medianLapTime: med(clean.map(l => l.time)),
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
        </div>
      </div>

      {data.map(dc => <DriverBlock key={dc.d.id} dc={dc} ctx={ctx} />)}
    </div>
  );
}

function DriverBlock({ dc, ctx }: { dc: DriverConsistency; ctx: ViewCtx }) {
  const { name, color } = ctx;
  const [hi, setHi] = useState<{ lap: number; z: number } | null>(null);
  const worst = [...dc.zones].sort((p, q) => q.onTheTable - p.onTheTable);
  const gap = dc.medianLapTime - dc.potential;
  const gapFromBest = dc.bestLapTime - dc.potential;
  const maxTable = Math.max(...dc.zones.map(z => z.onTheTable), 0.001);
  const bestIdx = dc.laps.reduce((a, b, i, arr) => (arr[i].time < arr[a].time ? i : a), 0);
  const maxTotal = Math.max(...dc.laps.map(l => Math.abs(l.total)), 0.001);

  return (
    <div className="panel p-4">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: color(dc.d) }} />
        <span className="text-[13px] font-medium">{name(dc.d)}</span>
        <span className="text-[11px] text-[var(--muted)] num">
          {dc.laps.length} кругов · σ круга {dc.d.stats.sd.toFixed(3)} с
        </span>
      </div>

      <div className="grid gap-5 xl:grid-cols-[auto_1fr] items-start">
        <div className="overflow-x-auto">
          <div className="inline-block">
            <div className="flex gap-[3px] mb-1" style={{ paddingLeft: 92 }}>
              {dc.zones.map(z => (
                <div key={z.z} className="text-[10px] text-[var(--muted-2)] text-center num" style={{ width: 32 }}>
                  {z.name}
                </div>
              ))}
            </div>

            {dc.laps.map((l, li) => (
              <div key={l.index} className="flex gap-[3px] items-center mb-[3px]">
                <div className="flex items-center justify-end gap-1.5" style={{ width: 88 }}>
                  {li === bestIdx && <span className="text-[9px] text-[var(--good)]" title="лучший круг">★</span>}
                  <span className="text-[10px] text-[var(--muted-2)] num">#{l.index}</span>
                  <span className="text-[10px] num" style={{ color: li === bestIdx ? 'var(--good)' : 'var(--muted)' }}>
                    {l.time.toFixed(2)}
                  </span>
                </div>

                {l.row.map((v, zi) => {
                  const t = Math.max(-1, Math.min(1, v / dc.scale));
                  const outlier = Math.abs(v) > 2 * dc.zones[zi].sd && Math.abs(v) > 0.05;
                  return (
                    <div key={zi}
                      onMouseEnter={() => setHi({ lap: li, z: zi })}
                      onMouseLeave={() => setHi(null)}
                      title={`Круг ${l.index} · ${dc.zones[zi].name} · ${delta(v)} с к своей медиане`}
                      className="rounded-[3px] cursor-default transition-transform hover:scale-110"
                      style={{
                        width: 32, height: 15,
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
                    width: `${(Math.abs(l.total) / maxTotal) * 50}%`,
                    background: l.total >= 0 ? 'rgba(255,107,107,0.5)' : 'rgba(81,207,102,0.5)',
                  }} />
                  <div className="absolute inset-y-0 left-1/2 w-px bg-[var(--line)]" />
                </div>
              </div>
            ))}

            <div className="text-[10px] text-[var(--muted-2)] mt-2 num" style={{ paddingLeft: 92 }}>
              шкала ±{dc.scale.toFixed(3)} с · белая рамка — выброс более 2σ (вероятно трафик или ошибка)
              · полоса справа — круг целиком
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 min-w-[280px]">
          <div className="rounded-lg p-3" style={{ background: 'rgba(255,212,59,0.07)' }}>
            <div className="text-[11px] text-[var(--muted)] mb-1">Потенциал круга</div>
            <div className="flex items-baseline gap-2">
              <span className="num text-xl font-semibold">{lapTime(dc.potential)}</span>
              <span className="num text-[12px] text-[var(--muted)]">
                из собственных лучших зон
              </span>
            </div>
            <div className="text-[12px] leading-relaxed mt-2 text-[var(--muted)]">
              Лучший реальный круг <span className="num text-[var(--text)]">{lapTime(dc.bestLapTime)}</span> —
              даже в нём <span className="num text-[var(--text)]">{gapFromBest.toFixed(3)} с</span> лежит на столе.
              В обычном круге <span className="num text-[var(--text)]">{gap.toFixed(3)} с</span>.
            </div>
            <div className="text-[10px] text-[var(--muted-2)] leading-relaxed mt-2">
              Это оптимистичный потолок, а не цель: он складывает лучшие зоны из разных кругов,
              которые не всегда совместимы в одном проезде, и частично ловит удачные замеры.
              Полезно сравнение между пилотами и слежение за тем, как разрыв сокращается.
            </div>
          </div>

          <div>
            <div className="text-[11px] text-[var(--muted)] mb-1.5">
              Где теряется больше всего относительно себя же
            </div>
            <table className="w-full text-[11px] num">
              <thead>
                <tr className="text-[10px] text-[var(--muted-2)]">
                  <th className="text-left font-normal pb-1">пов.</th>
                  <th className="text-right font-normal pb-1">на столе</th>
                  <th className="text-right font-normal pb-1">разброс σ</th>
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
                    <td className="py-1 text-right text-[var(--muted)]">{z.sd.toFixed(3)}</td>
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

          <Verdict dc={dc} worst={worst} gap={gap} />
        </div>
      </div>
    </div>
  );
}

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
