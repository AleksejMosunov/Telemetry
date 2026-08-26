import { useMemo, useState } from 'react';
import type { ViewCtx } from '../App';
import { TrackMap } from '../TrackMap';
import { CornerDetail } from './CornerDetail';
import { delta, num, deltaColor } from '../format';

const METRICS = [
  ['dt', 'потеря времени', 'с'],
  ['vmin', 'минимальная скорость', 'км/ч'],
  ['vexit', 'скорость на выходе', 'км/ч'],
  ['ventry', 'скорость на входе', 'км/ч'],
  ['brake', 'точка замедления', 'м'],
] as const;
type Metric = typeof METRICS[number][0];

export function Corners({ ctx }: { ctx: ViewCtx }) {
  const { a, ref, name, color, Z, V } = ctx;
  const [metric, setMetric] = useState<Metric>('dt');
  const [sel, setSel] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const shown = pinned ?? sel;

  const rows = useMemo(() => a.zones.map((z, i) => {
    const cells = a.drivers.map(d => {
      const zs = Z(d)[i], rs = Z(ref)[i];
      switch (metric) {
        case 'dt': return { v: zs.tZone - rs.tZone, raw: zs.tZone, d: zs.tZone - rs.tZone };
        case 'vmin': return { v: zs.vMin, raw: zs.vMin, d: zs.vMin - rs.vMin };
        case 'vexit': {
          const ve = V(d)[Math.round(z.corner.sEnd) % a.grid.length];
          return { v: ve, raw: ve, d: ve - V(ref)[Math.round(z.corner.sEnd) % a.grid.length] };
        }
        case 'ventry': return { v: zs.vEntry, raw: zs.vEntry, d: zs.vEntry - rs.vEntry };
        case 'brake': {
          let dd = zs.sBrake - rs.sBrake;
          if (dd > a.track.length / 2) dd -= a.track.length;
          if (dd < -a.track.length / 2) dd += a.track.length;
          return { v: zs.sBrake, raw: zs.sBrake, d: dd };
        }
      }
    });
    return { z, i, cells };
  }), [a, ref, metric, Z, V]);

  const totals = a.drivers.map(d => {
    const t = a.zones.reduce((s, _, i) => s + Z(d)[i].tZone, 0);
    const r = a.zones.reduce((s, _, i) => s + Z(ref)[i].tZone, 0);
    return t - r;
  });
  const maxAbs = Math.max(0.001, ...rows.flatMap(r => r.cells.map(c => Math.abs(metric === 'dt' ? c.d : 0))));

  const digits = metric === 'dt' ? 3 : metric === 'brake' ? 0 : 1;
  const lowerBetter = metric === 'dt' || metric === 'brake';

  const mapValues = useMemo(() => {
    const out = new Float64Array(a.grid.length);
    if (shown == null) return V(ref);
    const z = a.zones[shown];
    for (let i = 0; i < out.length; i++) {
      const inZone = z.sStart < z.sEnd ? i >= z.sStart && i <= z.sEnd : i >= z.sStart || i <= z.sEnd;
      out[i] = inZone ? 1 : 0;
    }
    return out;
  }, [shown, a, ref, V]);

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_470px] items-start">
      <div className="panel overflow-hidden">
        <div className="p-4 pb-3 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-[13px] font-medium">Разбор по поворотам</div>
            <div className="text-[11px] text-[var(--muted)]">
              Зоны покрывают круг целиком — потери суммируются точно в дельту круга. Клик по строке открывает разбор поворота
            </div>
          </div>
          <div className="flex rounded-lg border border-[var(--line)] overflow-hidden text-[11px]">
            {METRICS.map(([m, label]) => (
              <button key={m} onClick={() => setMetric(m)}
                className={`px-2.5 py-1 transition whitespace-nowrap ${metric === m ? 'bg-[var(--panel-2)]' : 'text-[var(--muted)] hover:text-[var(--text)]'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[12px] num border-collapse">
            <thead>
              <tr className="text-[var(--muted)] text-[11px]">
                <th className="text-left font-normal px-4 py-2 sticky left-0 bg-[var(--panel)]">пов.</th>
                <th className="text-right font-normal px-2 py-2">радиус</th>
                {a.drivers.map(d => (
                  <th key={d.id} className="text-right font-normal px-3 py-2 min-w-[100px]">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full" style={{ background: color(d) }} />
                      <span className="truncate max-w-[120px]">{name(d)}</span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ z, i, cells }) => (
                <tr key={i}
                  onMouseEnter={() => { setSel(i); ctx.setCursorS(z.corner.sApex); }}
                  onMouseLeave={() => { setSel(null); ctx.setCursorS(null); }}
                  onClick={() => setPinned(p => (p === i ? null : i))}
                  className={`border-t border-[var(--line-soft)] transition cursor-pointer
                    ${pinned === i ? 'bg-[var(--panel-2)]' : sel === i ? 'bg-white/[0.03]' : ''}`}>
                  <td className="px-4 py-2 sticky left-0 bg-inherit">
                    <span className="font-medium"
                      style={pinned === i ? { boxShadow: 'inset 0 -1px 0 currentColor' } : undefined}>
                      {z.corner.name}
                    </span>
                    <span className="text-[var(--muted-2)] ml-1.5 text-[10px]">{z.corner.dir === 'L' ? 'лев' : 'прав'}</span>
                  </td>
                  <td className="px-2 py-2 text-right text-[var(--muted)]">{z.corner.radius.toFixed(0)} м</td>
                  {cells.map((c, k) => {
                    const isRef = a.drivers[k].id === ref.id;
                    const good = lowerBetter ? c.d < 0 : c.d > 0;
                    return (
                      <td key={k} className="px-3 py-2 text-right relative">
                        {metric === 'dt' && !isRef && (
                          <span className="absolute inset-y-1 rounded-[3px] opacity-[0.16]"
                            style={{
                              background: c.d > 0 ? 'var(--bad)' : 'var(--good)',
                              right: c.d > 0 ? 0 : undefined, left: c.d < 0 ? 0 : undefined,
                              width: `${Math.min(100, (Math.abs(c.d) / maxAbs) * 55)}%`,
                            }} />
                        )}
                        <span className="relative">
                          {isRef
                            ? <span className="text-[var(--muted)]">
                                {metric === 'dt' ? `${c.raw.toFixed(3)} с` : num(c.v, digits)}
                              </span>
                            : <>
                              {metric !== 'dt' && <span className="text-[var(--muted)] mr-1.5">{num(c.v, digits)}</span>}
                              <span style={{ color: Math.abs(c.d) < 1e-9 ? 'var(--muted)' : good ? 'var(--good)' : 'var(--bad)' }}>
                                {delta(c.d, digits)}
                              </span>
                            </>}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr className="border-t border-[var(--line)] font-medium">
                <td className="px-4 py-2.5 sticky left-0 bg-[var(--panel)]">круг</td>
                <td />
                {a.drivers.map((d, k) => (
                  <td key={d.id} className="px-3 py-2.5 text-right">
                    {d.id === ref.id ? <span className="text-[var(--muted)]">опорный</span>
                      : <span style={{ color: deltaColor(totals[k]) }}>{delta(totals[k])}</span>}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="xl:sticky xl:top-[122px]">
        {shown != null ? (
          <CornerDetail ctx={ctx} zoneIndex={shown} />
        ) : (
          <div className="panel p-4">
            <div className="text-[13px] font-medium mb-1">Наведите на строку</div>
            <div className="text-[11px] text-[var(--muted)] mb-3">
              Кликните, чтобы закрепить разбор поворота и не терять его при движении мышью
            </div>
            <TrackMap a={a} mode="speed" values={mapValues} cursorS={ctx.cursorS} height={300} />
          </div>
        )}
      </div>

    </div>
  );
}
