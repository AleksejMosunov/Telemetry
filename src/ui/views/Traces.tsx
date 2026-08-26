import { useMemo } from 'react';
import type uPlot from 'uplot';
import type { ViewCtx } from '../App';
import { Chart } from '../Chart';
import { delta, num } from '../format';

const fmtSpeed = (v: number) => `${num(v)} км/ч`;
const fmtDelta = (v: number) => `${delta(v)} с`;
const fmtOffset = (v: number) => `${num(v, 2)} м`;

export function Traces({ ctx }: { ctx: ViewCtx }) {
  const { a, ref, name, color, V, T, LAT, cursorS, setCursorS } = ctx;
  const xs = useMemo(() => Array.from(a.grid), [a]);

  const bands = useMemo(
    () => a.corners.map(c => ({
      from: c.sStart, to: c.sEnd, label: c.name,
      sub: c.dir === 'L' ? 'левый' : 'правый',
    })),
    [a],
  );

  const mk = (get: (d: typeof a.drivers[0]) => Float64Array, skipRefZero = false) => {
    const rows = a.drivers.map(d => Array.from(get(d)));
    const series: uPlot.Series[] = [
      { label: 'м' },
      ...a.drivers.map(d => ({
        label: name(d), stroke: color(d),
        width: d.id === ref.id ? 2.2 : 1.6,
        dash: skipRefZero && d.id === ref.id ? [4, 4] : undefined,
      })),
    ];
    return { data: [xs, ...rows] as unknown as uPlot.AlignedData, series };
  };

  const speed = useMemo(() => mk(V), [a, V, name, color, xs]);
  const dt = useMemo(() => {
    const r = T(ref);
    const rows = a.drivers.map(d => { const t = T(d); return xs.map((_, i) => t[i] - r[i]); });
    const series: uPlot.Series[] = [
      { label: 'м' },
      ...a.drivers.map(d => ({
        label: name(d), stroke: color(d),
        width: d.id === ref.id ? 1 : 2,
        dash: d.id === ref.id ? [4, 4] : undefined,
      })),
    ];
    return { data: [xs, ...rows] as unknown as uPlot.AlignedData, series };
  }, [a, T, ref, name, color, xs]);
  const lat = useMemo(() => mk(LAT), [a, LAT, name, color, xs]);

  const idx = cursorS == null ? null : Math.max(0, Math.min(xs.length - 1, Math.round(cursorS)));
  const cornerAt = idx == null ? null : a.corners.find(c => idx >= c.sStart && idx <= c.sEnd);

  return (
    <div className="flex flex-col gap-3">
      <div className="panel px-4 py-3 flex items-center gap-5 flex-wrap text-[12px] num">
        <span className="text-[var(--muted)] text-[11px]">
          {idx == null ? 'наведите на график' : `${idx} м${cornerAt ? ` · ${cornerAt.name}` : ''}`}
        </span>
        {idx != null && a.drivers.map(d => (
          <span key={d.id} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: color(d) }} />
            <span className="text-[var(--muted)]">{name(d)}</span>
            <span>{num(V(d)[idx])} км/ч</span>
            {d.id !== ref.id && (
              <span className="text-[var(--muted-2)]">
                ({(T(d)[idx] - T(ref)[idx]) >= 0 ? '+' : '−'}{Math.abs(T(d)[idx] - T(ref)[idx]).toFixed(3)} с)
              </span>
            )}
          </span>
        ))}
      </div>

      <Panel title="Скорость" hint="км/ч по дистанции круга; сверху — номера поворотов">
        <Chart data={speed.data} series={speed.series} height={230} yLabel="км/ч"
          bands={bands} bandAxis syncKey="tr" onCursor={setCursorS} fmt={fmtSpeed} xUnit="м" />
      </Panel>

      <Panel title={`Накопленная дельта к «${name(ref)}»`} hint="выше нуля — теряет время; наклон показывает, где именно">
        <Chart data={dt.data} series={dt.series} height={200} yLabel="сек"
          bands={bands} bandAxis syncKey="tr" onCursor={setCursorS} fmt={fmtDelta} xUnit="м" />
      </Panel>

      <Panel title="Боковое смещение от осевой линии" hint="плюс — левее опорной траектории; расхождение линий = разные траектории">
        <Chart data={lat.data} series={lat.series} height={180} yLabel="м"
          bands={bands} bandAxis syncKey="tr" onCursor={setCursorS} fmt={fmtOffset} xUnit="м" />
      </Panel>
    </div>
  );
}

function Panel({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="panel p-4">
      <div className="text-[13px] font-medium">{title}</div>
      <div className="text-[11px] text-[var(--muted)] mb-1">{hint}</div>
      {children}
    </div>
  );
}
