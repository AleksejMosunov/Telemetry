import { useMemo, useRef, useState } from 'react';
import type { ViewCtx } from '../App';
import { TrackMap, MapLegend } from '../TrackMap';
import { deltaRate } from '../../core/analysis';
import { CornerDetail } from './CornerDetail';
import { delta, num, deltaColor } from '../format';

/** Отметки на круге сравниваем по кольцу: у поворота на старт/финише разность
 *  иначе получилась бы в длину круга. */
function ring(v: number, r: number, length: number) {
  let d = v - r;
  if (d > length / 2) d -= length;
  if (d < -length / 2) d += length;
  return { v, raw: v, d };
}

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
  ['smin', 'низшая точка', 'м',
   'Где внутри поворота скорость самая низкая, в метрах от старт/финиша. Это то самое кольцо на карте зоны. Раньше низшая точка — раньше можно открываться.'],
  ['accel', 'точка разгона', 'м',
   'Где после низшей точки скорость снова пошла вверх — то есть где карт поехал. Между точкой замедления и точкой разгона он не ускоряется, и чем короче этот участок, тем лучше. Прочерк значит, что разгон в пределах зоны так и не начался.'],
  ['coast', 'не ускоряется', 'м',
   'Длина участка от конца разгона до его начала в следующий раз. Педалей в логе нет, поэтому это честно называется «не ускоряется», а не «накат» или «торможение»: скорость может не расти и от тормоза, и от сброса газа, и просто оттого, что её съедает дуга. Чем короче участок, тем раньше карт снова едет. Прочерк — точки замедления в зоне нет.'],
  ['unwind', 'распрямил руль', 'м',
   'Через сколько метров после апекса карт перестаёт вращаться — то есть с какого места он едет прямо и можно открывать газ. Считается по гироскопу: не угол руля (его из телеметрии не восстановить — снос шин не наблюдается), а радиус, который карт реально пишет. Считается только до входа в следующий поворот, и карт должен ехать прямо хотя бы 15 м подряд — иначе метрика ловит мгновенный сброс дуги в середине шпильки, а не выход. Меньше — раньше распрямился. Прочерк — либо связка, где карт так и не распрямился до следующего поворота, либо в логе нет гироскопа.'],
  ['hop', 'скачки', 'g',
   'Насколько трясёт карт в этой зоне: быстрая часть вертикального ускорения. Ловит места, где карт прыгает, бьёт по поребрику или ловит кочку, но не различает, что именно из этого происходит — для этого нужна запись быстрее 20 Гц. Прочерк — в логе нет канала вертикального ускорения.'],
] as const;
type Metric = typeof METRICS[number][0];

/** Десять метрик в одну строку не читаются, поэтому они разложены по вопросу,
 *  на который отвечают: сколько потерял, с какой скоростью ехал, где на круге
 *  это произошло и как именно проходил поворот. Внутри «скорости» порядок
 *  такой же, как в самом повороте: вход → низшая точка → выход. */
const GROUPS: Array<{ name: string; items: Metric[] }> = [
  { name: 'время', items: ['dt'] },
  { name: 'скорость', items: ['ventry', 'vmin', 'vexit'] },
  { name: 'где на круге', items: ['brake', 'smin', 'accel'] },
  { name: 'как проходит', items: ['coast', 'unwind', 'hop'] },
];

export function Corners({ ctx }: { ctx: ViewCtx }) {
  const { a, cmp, ref, name, color, Z, V, ZU } = ctx;
  const [metric, setMetric] = useState<Metric>('dt');
  const [sel, setSel] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const shown = pinned ?? sel;
  const group = GROUPS.find(g => (g.items as Metric[]).includes(metric)) ?? GROUPS[0];
  // Возврат в группу должен открывать ту метрику, на которой её оставили,
  // иначе переключение между группами каждый раз сбрасывает выбор на первую.
  const lastInGroup = useRef<Record<string, Metric>>({});
  lastInGroup.current[group.name] = metric;

  const rows = useMemo(() => a.zones.map((z, i) => {
    const cells = cmp.map(d => {
      const zs = Z(d)[i], rs = Z(ref)[i];
      switch (metric) {
        case 'dt': return { v: zs.tZone - rs.tZone, raw: zs.tZone, d: zs.tZone - rs.tZone };
        case 'vmin': return { v: zs.vMin, raw: zs.vMin, d: zs.vMin - rs.vMin };
        case 'vexit': {
          const ve = V(d)[Math.round(z.corner.sEnd) % a.grid.length];
          return { v: ve, raw: ve, d: ve - V(ref)[Math.round(z.corner.sEnd) % a.grid.length] };
        }
        case 'ventry': return { v: zs.vEntry, raw: zs.vEntry, d: zs.vEntry - rs.vEntry };
        case 'brake': return ring(zs.sBrake, rs.sBrake, a.track.length);
        case 'smin': return ring(zs.sMin, rs.sMin, a.track.length);
        case 'accel': return ring(zs.sAccel, rs.sAccel, a.track.length);
        case 'coast': {
          const v = zs.sAccel - zs.sBrake, r = rs.sAccel - rs.sBrake;
          return { v, raw: v, d: v - r };
        }
        case 'unwind': {
          const v = ZU(d)[i], r = ZU(ref)[i];
          return { v, raw: v, d: v - r };
        }
        case 'hop': return { v: zs.hop, raw: zs.hop, d: zs.hop - rs.hop };
      }
    });
    return { z, i, cells };
  }), [a, cmp, ref, metric, Z, V, ZU]);

  const totals = cmp.map(d => {
    const t = a.zones.reduce((s, _, i) => s + Z(d)[i].tZone, 0);
    const r = a.zones.reduce((s, _, i) => s + Z(ref)[i].tZone, 0);
    return t - r;
  });
  const maxAbs = Math.max(0.001, ...rows.flatMap(r => r.cells.map(c => Math.abs(metric === 'dt' ? c.d : 0))));

  const unit = METRICS.find(([m]) => m === metric)![2];
  const isMark = metric === 'brake' || metric === 'smin' || metric === 'accel';
  const digits = metric === 'dt' || metric === 'hop' ? 3
    : isMark || metric === 'coast' || metric === 'unwind' ? 0 : 1;
  // Отметки на круге сравниваются как «раньше — зелёное»: для низшей точки и
  // разгона это прямо хорошо, для торможения так было заведено с самого начала.
  // Распрямился раньше — раньше открыл газ, поэтому меньше тоже лучше.
  const lowerBetter = metric === 'dt' || isMark || metric === 'coast' || metric === 'hop'
    || metric === 'unwind';

  /** Пилот, чьи потери показывает карта: самый медленный из неопорных. */
  const lossOf = useMemo(() => {
    const others = cmp.filter(d => d.id !== ref.id);
    return others.length
      ? others.reduce((p, q) => (p.stats.median >= q.stats.median ? p : q))
      : null;
  }, [cmp, ref]);

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
  }, [lossOf, a, cmp, ref, Z, V]);

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
            {GROUPS.map(g => (
              <button key={g.name} onClick={() => setMetric(lastInGroup.current[g.name] ?? g.items[0])}
                className={`px-2.5 py-1 transition whitespace-nowrap ${g === group ? 'bg-[var(--panel-2)]' : 'text-[var(--muted)] hover:text-[var(--text)]'}`}>
                {g.name}
              </button>
            ))}
          </div>
          </div>
        </div>

        {group.items.length > 1 && (
          <div className="px-4 -mt-1 pb-2 scroll-x">
            <div className="flex w-max gap-1 text-[11px]">
              {group.items.map(m => (
                <button key={m} onClick={() => setMetric(m)}
                  className={`px-2 py-0.5 rounded transition whitespace-nowrap ${metric === m
                    ? 'bg-[var(--panel-2)] text-[var(--text)]'
                    : 'text-[var(--muted-2)] hover:text-[var(--text)]'}`}>
                  {METRICS.find(([k]) => k === m)![1]}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="px-4 pb-3 text-[11px] text-[var(--muted)] leading-relaxed max-w-[720px]">
          {METRICS.find(([m]) => m === metric)![3]}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[12px] num border-collapse">
            <thead>
              <tr className="text-[var(--muted)] text-[11px]">
                <th className="text-left font-normal px-4 py-2 sticky left-0 bg-[var(--panel)]">пов.</th>
                {cmp.map(d => (
                  <th key={d.id} className="text-right font-normal px-3 py-2 min-w-[110px] align-bottom">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color(d) }} />
                      <span className="truncate max-w-[160px]">
                        {ctx.nameParts(d).base}<span className="text-[var(--muted-2)] font-normal">, {unit}</span>
                      </span>
                    </span>
                    {/* Номер круга не обрезается вместе с именем — иначе не видно,
                        какой именно круг стоит в колонке. */}
                    {ctx.nameParts(d).tag && (
                      <span className="block text-[10px] text-[var(--muted-2)] font-normal whitespace-nowrap">
                        {ctx.nameParts(d).tag}
                      </span>
                    )}
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
                    const isRef = cmp[k].id === ref.id;
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
                  {cmp.map((d, k) => (
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
