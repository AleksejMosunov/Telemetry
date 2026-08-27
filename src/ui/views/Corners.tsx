import { useMemo, useState } from 'react';
import type { ViewCtx } from '../App';
import { TrackMap, MapLegend } from '../TrackMap';
import { deltaRate } from '../../core/analysis';
import { CornerDetail } from './CornerDetail';
import { delta, num, deltaColor } from '../format';

const METRICS = [
  ['dt', 'потеря времени', 'с',
   'Сколько времени пилот теряет или выигрывает в зоне относительно опорного. Сумма по всем зонам равна дельте круга.'],
  ['vmin', 'минимальная скорость', 'км/ч',
   'Самая низкая скорость внутри поворота. Это не геометрический апекс — низшая точка обычно оказывается позже него.'],
  ['vexit', 'скорость на выходе', 'км/ч',
   'Скорость в момент выхода из поворота. От неё зависит вся последующая прямая, поэтому она важнее скорости в апексе.'],
  ['ventry', 'скорость на входе', 'км/ч',
   'Скорость в момент входа в поворот, до начала дуги.'],
  ['brake', 'точка замедления', 'м',
   'Отметка на круге, в метрах от старт/финиша, где кончается разгон и начинается замедление перед этим поворотом. Меньше — тормозит раньше. Прочерк значит, что точки замедления нет вообще: поворот либо проходится без сброса скорости, либо входит в связку и торможение относилось к предыдущему.'],
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

  const unit = METRICS.find(([m]) => m === metric)![2];
  const digits = metric === 'dt' ? 3 : metric === 'brake' ? 0 : 1;
  const lowerBetter = metric === 'dt' || metric === 'brake';

  /** Пилот, чьи потери показывает карта: самый медленный из неопорных. */
  const lossOf = useMemo(() => {
    const others = a.drivers.filter(d => d.id !== ref.id);
    return others.length
      ? others.reduce((p, q) => (p.stats.median >= q.stats.median ? p : q))
      : null;
  }, [a, ref]);

  const mapValues = useMemo(
    () => (lossOf ? deltaRate(ctx.T(lossOf), ctx.T(ref)) : V(ref)),
    [lossOf, ref, ctx, V],
  );

  const mapRange = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const v of mapValues) { if (!isFinite(v)) continue; lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return { lo, hi, absMax: Math.max(Math.abs(lo), Math.abs(hi)) };
  }, [mapValues]);

  const mapCornerLabel = useMemo(() => {
    if (!lossOf) {
      return (ci: number) => `${V(ref)[Math.round(a.corners[ci].sApex) % a.grid.length].toFixed(0)}`;
    }
    return (ci: number) => {
      const zi = a.zones.findIndex(z => z.corner.id === a.corners[ci].id);
      if (zi < 0) return null;
      const dt = Z(lossOf)[zi].tZone - Z(ref)[zi].tZone;
      return `${dt >= 0 ? '+' : '−'}${Math.abs(dt).toFixed(2)}`;
    };
  }, [lossOf, a, ref, Z, V]);

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
          <div className="scroll-x max-w-full -mx-1 px-1">
          <div className="flex w-max rounded-lg border border-[var(--line)] overflow-hidden text-[11px]">
            {METRICS.map(([m, label]) => (
              <button key={m} onClick={() => setMetric(m)}
                className={`px-2.5 py-1 transition whitespace-nowrap ${metric === m ? 'bg-[var(--panel-2)]' : 'text-[var(--muted)] hover:text-[var(--text)]'}`}>
                {label}
              </button>
            ))}
          </div>
          </div>
        </div>

        <div className="px-4 pb-3 -mt-1 text-[11px] text-[var(--muted)] leading-relaxed max-w-[720px]">
          {METRICS.find(([m]) => m === metric)![3]}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[12px] num border-collapse">
            <thead>
              <tr className="text-[var(--muted)] text-[11px]">
                <th className="text-left font-normal px-4 py-2 sticky left-0 bg-[var(--panel)]">пов.</th>
                {a.drivers.map(d => (
                  <th key={d.id} className="text-right font-normal px-3 py-2 min-w-[110px]">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full" style={{ background: color(d) }} />
                      <span className="truncate max-w-[160px]">
                        {name(d)}<span className="text-[var(--muted-2)] font-normal">, {unit}</span>
                      </span>
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
                    <span className="text-[var(--muted-2)] ml-2 text-[10px]"
                      title="Направление и наименьший радиус дуги — насколько поворот крутой">
                      {z.corner.dir === 'L' ? 'лев' : 'прав'} · R {z.corner.radius.toFixed(0)} м
                    </span>
                  </td>
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
                                {metric === 'dt' ? c.raw.toFixed(3) : num(c.v, digits)}
                              </span>
                            : <>
                              {metric !== 'dt' && <span className="text-[var(--muted)] mr-1.5">{num(c.v, digits)}</span>}
                              {isFinite(c.d) && (
                                <span style={{ color: Math.abs(c.d) < 1e-9 ? 'var(--muted)' : good ? 'var(--good)' : 'var(--bad)' }}>
                                  {delta(c.d, digits)}
                                </span>
                              )}
                            </>}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {metric === 'dt' && (
                <tr className="border-t border-[var(--line)] font-medium">
                  <td className="px-4 py-2.5 sticky left-0 bg-[var(--panel)]">
                    круг
                    <span className="text-[var(--muted-2)] ml-2 text-[10px] font-normal">сумма всех зон</span>
                  </td>
                  {a.drivers.map((d, k) => (
                    <td key={d.id} className="px-3 py-2.5 text-right">
                      {d.id === ref.id ? <span className="text-[var(--muted)]">опорный</span>
                        : <span style={{ color: deltaColor(totals[k]) }}>{delta(totals[k])}</span>}
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="xl:sticky xl:top-[122px]">
        {shown != null ? (
          <CornerDetail ctx={ctx} zoneIndex={shown} />
        ) : (
          <div className="panel p-4">
            <div className="text-[13px] font-medium mb-0.5">
              {lossOf ? 'Где теряется время' : 'Трасса'}
            </div>
            <div className="text-[11px] text-[var(--muted)] mb-2">
              Наведите на строку — откроется разбор поворота. Клик закрепит его.
            </div>
            <TrackMap a={a} mode={lossOf ? 'delta' : 'speed'} values={mapValues}
              cornerLabel={mapCornerLabel} cursorS={ctx.cursorS} height={340} />
            <MapLegend mode={lossOf ? 'delta' : 'speed'} min={mapRange.lo}
              max={lossOf ? mapRange.absMax * 100 : mapRange.hi}
              unit={lossOf ? 'с на 100 м' : 'км/ч'} />
            <div className="text-[11px] text-[var(--muted-2)] mt-2 leading-relaxed">
              {lossOf
                ? `Красное — где «${name(lossOf)}» теряет время относительно «${name(ref)}», зелёное — где выигрывает. Числа у поворотов — потеря в зоне, с.`
                : `Цвет и числа у поворотов — скорость в апексе, км/ч.`}
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
