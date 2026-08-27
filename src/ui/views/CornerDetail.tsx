import { useEffect, useMemo, useRef } from 'react';
import type uPlot from 'uplot';
import type { ViewCtx } from '../App';
import type { DriverResult } from '../../core/pipeline';
import { zoneIndices, lineXY } from '../TrackMap';
import { Chart } from '../Chart';
import { delta, num, deltaColor } from '../format';

const fmtSpeedV = (v: number) => `${num(v)} км/ч`;

/** Крупный план одного поворота: реальные траектории пилотов, апекс, точки замедления. */
function CornerMap({ ctx, zoneIndex, height = 260 }: { ctx: ViewCtx; zoneIndex: number; height?: number }) {
  const { a, color, LAT, LATSD, Z, V } = ctx;
  const cv = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const c = cv.current, wrap = box.current;
    if (!c || !wrap) return;
    const z = a.zones[zoneIndex];
    const n = a.track.n;
    const idxs = zoneIndices(z.sStart, z.sEnd, n);

    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth, H = height;
    c.width = W * dpr; c.height = H * dpr;
    c.style.width = `${W}px`; c.style.height = `${H}px`;
    const ctx2 = c.getContext('2d')!;
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2.clearRect(0, 0, W, H);

    const lines = a.drivers.map(d => ({ d, xy: lineXY(a, LAT(d), idxs) }));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const i of idxs) {
      minX = Math.min(minX, a.track.x[i]); maxX = Math.max(maxX, a.track.x[i]);
      minY = Math.min(minY, a.track.y[i]); maxY = Math.max(maxY, a.track.y[i]);
    }
    const pad = 26;
    const sc = Math.min((W - 2 * pad) / (maxX - minX || 1), (H - 2 * pad) / (maxY - minY || 1));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const px = (v: number) => W / 2 + (v - cx) * sc;
    const py = (v: number) => H / 2 - (v - cy) * sc;

    // полотно трассы
    ctx2.lineCap = 'round'; ctx2.lineJoin = 'round';
    ctx2.strokeStyle = '#1c2230'; ctx2.lineWidth = Math.max(14, 7 * sc);
    ctx2.beginPath();
    idxs.forEach((i, k) => (k ? ctx2.lineTo(px(a.track.x[i]), py(a.track.y[i]))
      : ctx2.moveTo(px(a.track.x[i]), py(a.track.y[i]))));
    ctx2.stroke();

    // коридор разброса: где линия гуляет от круга к кругу
    for (const d of a.drivers) {
      const sd = LATSD(d);
      if (!sd) continue;
      const lat = LAT(d);
      const band = (sign: number) => idxs.map(i => lat[i] + sign * sd[i]);
      const hi = lineXY(a, Float64Array.from(band(1)), idxs);
      const lo = lineXY(a, Float64Array.from(band(-1)), idxs);
      ctx2.fillStyle = color(d) + '22';
      ctx2.beginPath();
      hi[0].forEach((X, k) => (k ? ctx2.lineTo(px(X), py(hi[1][k])) : ctx2.moveTo(px(X), py(hi[1][k]))));
      for (let k = lo[0].length - 1; k >= 0; k--) ctx2.lineTo(px(lo[0][k]), py(lo[1][k]));
      ctx2.closePath();
      ctx2.fill();
    }

    // траектории
    for (const { d, xy } of lines) {
      ctx2.strokeStyle = color(d); ctx2.lineWidth = 2.4;
      ctx2.beginPath();
      xy[0].forEach((X, k) => (k ? ctx2.lineTo(px(X), py(xy[1][k])) : ctx2.moveTo(px(X), py(xy[1][k]))));
      ctx2.stroke();

      // точка начала замедления
      const sb = Math.round(Z(d)[zoneIndex].sBrake) % n;
      const k = idxs.indexOf(sb);
      if (k >= 0) {
        ctx2.fillStyle = color(d);
        ctx2.beginPath(); ctx2.arc(px(xy[0][k]), py(xy[1][k]), 4.5, 0, Math.PI * 2); ctx2.fill();
        ctx2.strokeStyle = '#0a0c10'; ctx2.lineWidth = 1.5; ctx2.stroke();
      }

      // реальная низшая точка — она почти никогда не совпадает с геометрическим апексом
      const c = a.zones[zoneIndex].corner;
      let bv = Infinity, bs = Math.round(c.sStart);
      for (let sPos = Math.round(c.sStart); sPos <= Math.round(c.sEnd); sPos++) {
        const i = sPos % n;
        if (V(d)[i] < bv) { bv = V(d)[i]; bs = sPos; }
      }
      const km = idxs.indexOf(bs % n);
      if (km >= 0) {
        ctx2.strokeStyle = color(d); ctx2.lineWidth = 2;
        ctx2.beginPath(); ctx2.arc(px(xy[0][km]), py(xy[1][km]), 5.5, 0, Math.PI * 2); ctx2.stroke();
      }
    }

    // апекс
    const ap = Math.round(a.zones[zoneIndex].corner.sApex) % n;
    ctx2.strokeStyle = '#7d879b'; ctx2.lineWidth = 1.5;
    ctx2.setLineDash([3, 3]);
    ctx2.beginPath();
    ctx2.arc(px(a.track.x[ap]), py(a.track.y[ap]), 7, 0, Math.PI * 2);
    ctx2.stroke();
    ctx2.setLineDash([]);
    ctx2.fillStyle = '#7d879b';
    ctx2.font = '10px ui-sans-serif, system-ui';
    ctx2.textAlign = 'center';
    ctx2.fillText('апекс', px(a.track.x[ap]), py(a.track.y[ap]) - 13);
  }, [a, zoneIndex, height, color, LAT, LATSD, Z, V]);

  return <div ref={box} style={{ width: '100%' }}><canvas ref={cv} style={{ display: 'block' }} /></div>;
}

/** Короткий разбор: что именно пошло не так в этом повороте. */
function diagnose(ctx: ViewCtx, d: DriverResult, zi: number): string[] {
  const { a, ref, name } = ctx;
  const zd = ctx.Z(d)[zi], zr = ctx.Z(ref)[zi];
  const dt = zd.tZone - zr.tZone;
  if (Math.abs(dt) < 0.02) return [`Разницы практически нет — ${delta(dt)} с.`];

  const out: string[] = [];
  const dApex = zd.vMin - zr.vMin;
  const N = a.grid.length;
  const ce = Math.round(a.corners[zi].sEnd) % N;
  const dExit = ctx.V(d)[ce] - ctx.V(ref)[ce];
  let dBrake = zd.sBrake - zr.sBrake;
  if (dBrake > a.track.length / 2) dBrake -= a.track.length;
  if (dBrake < -a.track.length / 2) dBrake += a.track.length;
  const dPath = ctx.ZP(d)[zi] - ctx.ZP(ref)[zi];

  if (isFinite(dBrake) && Math.abs(dBrake) >= 3) {
    out.push(`Замедляться начинает на ${Math.abs(dBrake).toFixed(0)} м ${dBrake < 0 ? 'раньше' : 'позже'}.`);
  }
  if (dApex > 1 && dExit < -0.5) {
    out.push(`В низшей точке быстрее на ${dApex.toFixed(1)} км/ч, но на выходе медленнее на ${Math.abs(dExit).toFixed(1)} км/ч. ` +
      `Перебор на входе: карт не встаёт на дугу, руль остаётся повёрнутым, газ открывается позже.`);
  } else if (dApex < -1 && dExit < -0.5) {
    out.push(`Медленнее и в низшей точке (−${Math.abs(dApex).toFixed(1)} км/ч), и на выходе (−${Math.abs(dExit).toFixed(1)} км/ч). ` +
      `Теряет по всей дуге, а не в одной точке.`);
  } else if (dApex < -1 && dExit > 0.5) {
    out.push(`Жертвует скоростью в повороте (−${Math.abs(dApex).toFixed(1)} км/ч) ради выхода (+${dExit.toFixed(1)} км/ч). ` +
      `Обычно это правильный размен — смотри, окупается ли он на следующей прямой.`);
  } else if (Math.abs(dApex) <= 1 && Math.abs(dExit) <= 0.5) {
    out.push(`Скорости почти совпадают — время теряется на форме траектории, а не на скорости.`);
  }
  if (Math.abs(dPath) > 0.4) {
    out.push(`Проезжает на ${Math.abs(dPath).toFixed(1)} м ${dPath > 0 ? 'длиннее' : 'короче'} внутри зоны.`);
  }
  if (!out.length) out.push(`Потеря ${delta(dt)} с распределена по зоне без явной одной причины.`);
  return out;
}

export function CornerDetail({ ctx, zoneIndex }: { ctx: ViewCtx; zoneIndex: number }) {
  const { a, ref, name, color, V, Z } = ctx;
  const z = a.zones[zoneIndex];
  const c = z.corner;
  const N = a.grid.length;
  const idxs = useMemo(() => zoneIndices(z.sStart, z.sEnd, a.track.n), [z, a]);
  const others = a.drivers.filter(d => d.id !== ref.id);

  const chart = useMemo(() => {
    const xs = idxs.map((_, k) => k);
    const rows = a.drivers.map(d => idxs.map(i => V(d)[i]));
    const series: uPlot.Series[] = [
      { label: 'м' },
      ...a.drivers.map(d => ({ label: name(d), stroke: color(d), width: d.id === ref.id ? 2.2 : 1.8 })),
    ];
    return { data: [xs, ...rows] as unknown as uPlot.AlignedData, series };
  }, [idxs, a, V, name, color, ref]);

  const bands = useMemo(() => {
    const s = idxs.indexOf(Math.round(c.sStart) % a.track.n);
    const e = idxs.indexOf(Math.round(c.sEnd) % a.track.n);
    return s >= 0 && e > s ? [{ from: s, to: e, label: c.name }] : undefined;
  }, [idxs, c, a]);

  const ce = Math.round(c.sEnd) % N;
  const cs = Math.round(c.sStart) % N;

  const metrics = [
    { label: 'скорость на входе', get: (d: DriverResult) => V(d)[cs], unit: 'км/ч', d: 1, up: true,
      hint: 'Скорость в точке, где начинается дуга поворота.' },
    { label: 'минимальная скорость', get: (d: DriverResult) => Z(d)[zoneIndex].vMin, unit: 'км/ч', d: 1, up: true,
      hint: 'Самая низкая скорость внутри поворота. Обычно приходится позже геометрического апекса.' },
    { label: 'скорость на выходе', get: (d: DriverResult) => V(d)[ce], unit: 'км/ч', d: 1, up: true,
      hint: 'Скорость там, где дуга заканчивается. От неё зависит вся следующая прямая.' },
    { label: 'точка замедления', get: (d: DriverResult) => Z(d)[zoneIndex].sBrake, unit: 'м', d: 0, up: true,
      hint: 'Где кончается разгон перед этим поворотом. Прочерк — поворот проходится без сброса скорости либо входит в связку с предыдущим.' },
    { label: 'длина траектории', get: (d: DriverResult) => ctx.ZP(d)[zoneIndex], unit: 'м', d: 1, up: false,
      hint: 'Сколько метров реально проехал внутри этой зоны по своей траектории.' },
    { label: 'время в зоне', get: (d: DriverResult) => Z(d)[zoneIndex].tZone, unit: 'с', d: 3, up: false,
      hint: 'Время от начала зоны до её конца. Сумма по всем зонам равна времени круга.' },
  ];

  return (
    <div className="panel p-4 flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[15px] font-semibold">
            {c.name} <span className="text-[var(--muted)] font-normal text-[12px] ml-1">
              {c.dir === 'L' ? 'левый' : 'правый'} · радиус {c.radius.toFixed(0)} м
            </span>
          </div>
          <div className="text-[11px] text-[var(--muted)] num">
            зона {z.sStart.toFixed(0)}–{z.sEnd.toFixed(0)} м · поворот {c.sStart.toFixed(0)}–{c.sEnd.toFixed(0)} м
          </div>
        </div>
        {others.map(d => {
          const dt = Z(d)[zoneIndex].tZone - Z(ref)[zoneIndex].tZone;
          return (
            <div key={d.id} className="text-right">
              <div className="num text-lg font-semibold" style={{ color: deltaColor(dt) }}>{delta(dt)}</div>
              <div className="text-[10px] text-[var(--muted-2)] truncate max-w-[130px]">{name(d)}</div>
            </div>
          );
        })}
      </div>

      <CornerMap ctx={ctx} zoneIndex={zoneIndex} />
      <div className="text-[10px] text-[var(--muted-2)] -mt-2">
        Линия — усреднённая траектория, заливка — обычный разброс линии по кругам.
        Залитая точка — начало замедления, кольцо — реальная низшая точка скорости.
        Пунктирный кружок — геометрический апекс: они часто не совпадают.
      </div>

      <div>
        <div className="text-[11px] text-[var(--muted)] mb-1">Скорость по зоне, км/ч</div>
        <Chart data={chart.data} series={chart.series} height={140} bands={bands} fmt={fmtSpeedV} />
      </div>

      <div className="scroll-x -mx-1 px-1">
      <table className="w-full min-w-[420px] text-[12px] num">
        <thead>
          <tr className="text-[10px] text-[var(--muted)]">
            <th className="text-left font-normal pb-1.5" />
            {a.drivers.map(d => (
              <th key={d.id} className="text-right font-normal pb-1.5">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: color(d) }} />
                  <span className="truncate max-w-[110px]">{name(d)}</span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {metrics.map(m => {
            const rv = m.get(ref);
            return (
              <tr key={m.label} className="border-t border-[var(--line-soft)]" title={m.hint}>
                <td className="py-1.5 text-[var(--muted)] decoration-dotted decoration-[var(--muted-2)] underline underline-offset-[3px] cursor-help">
                  {m.label}
                </td>
                {a.drivers.map(dr => {
                  const v = m.get(dr);
                  const dd = v - rv;
                  const good = m.up ? dd > 0 : dd < 0;
                  return (
                    <td key={dr.id} className="py-1.5 text-right">
                      {num(v, m.d)}<span className="text-[var(--muted-2)] text-[10px]"> {m.unit}</span>
                      {dr.id !== ref.id && Math.abs(dd) > 10 ** -m.d / 2 && (
                        <span className="ml-1.5 text-[11px]"
                          style={{ color: good ? 'var(--good)' : 'var(--bad)' }}>{delta(dd, m.d)}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>

      {others.map(d => (
        <div key={d.id} className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.028)' }}>
          <div className="text-[11px] mb-1.5 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: color(d) }} />
            <span className="text-[var(--muted)]">{name(d)} против «{name(ref)}»</span>
          </div>
          <ul className="text-[12.5px] leading-relaxed flex flex-col gap-1">
            {diagnose(ctx, d, zoneIndex).map((t, i) => (
              <li key={i} className="text-[var(--text)]">{t}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
