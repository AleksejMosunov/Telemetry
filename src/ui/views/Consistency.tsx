import { useMemo, useState } from 'react';
import type { ViewCtx } from '../App';
import { lapTime } from '../format';

/** Тепловая карта «круги × повороты»: где пилот стабилен, а где рулетка. */
export function Consistency({ ctx }: { ctx: ViewCtx }) {
  const { a, name, color } = ctx;
  const [hover, setHover] = useState<{ d: string; lap: number; zone: number; v: number } | null>(null);

  const data = useMemo(() => a.drivers.map(d => {
    const cleanLaps = d.laps.filter(l => l.clean);
    const nz = a.zones.length;
    const medians = new Float64Array(nz);
    for (let z = 0; z < nz; z++) {
      const col = d.zoneByLap.map(r => r[z]).sort((p, q) => p - q);
      medians[z] = col[col.length >> 1];
    }
    const rows = d.zoneByLap.map(r => Array.from({ length: nz }, (_, z) => r[z] - medians[z]));
    const flat = rows.flat().filter(v => isFinite(v));
    const scale = Math.max(0.02, percentile(flat.map(Math.abs), 0.9));
    // разброс по каждой зоне — где пилот теряет повторяемость
    const spread = Array.from({ length: nz }, (_, z) => {
      const col = rows.map(r => r[z]);
      const m = col.reduce((p, q) => p + q, 0) / col.length;
      return Math.sqrt(col.reduce((p, q) => p + (q - m) ** 2, 0) / col.length);
    });
    return { d, cleanLaps, rows, scale, spread };
  }), [a]);

  return (
    <div className="flex flex-col gap-4">
      <div className="panel p-4">
        <div className="text-[13px] font-medium">Повторяемость по поворотам</div>
        <div className="text-[11px] text-[var(--muted)]">
          Каждая клетка — отклонение круга от собственной медианы пилота в этой зоне.
          Красное — медленнее обычного, зелёное — быстрее. Ровный столбец = поворот отработан на автомате.
        </div>
      </div>

      {data.map(({ d, cleanLaps, rows, scale, spread }) => (
        <div key={d.id} className="panel p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: color(d) }} />
            <span className="text-[13px] font-medium">{name(d)}</span>
            <span className="text-[11px] text-[var(--muted)] num ml-1">
              {cleanLaps.length} кругов · σ круга {d.stats.sd.toFixed(3)} с
            </span>
            {(() => {
              const worst = spread.indexOf(Math.max(...spread));
              return (
                <span className="text-[11px] text-[var(--muted-2)] ml-auto">
                  самый нестабильный — {a.zones[worst].corner.name} (σ {spread[worst].toFixed(3)} с)
                </span>
              );
            })()}
          </div>

          <div className="overflow-x-auto">
            <div className="inline-block min-w-full">
              <div className="flex gap-[3px] mb-1 pl-[46px]">
                {a.zones.map((z, i) => (
                  <div key={i} className="text-[10px] text-[var(--muted-2)] text-center num"
                    style={{ width: 30 }}>{z.corner.name}</div>
                ))}
              </div>
              {rows.map((row, li) => (
                <div key={li} className="flex gap-[3px] items-center mb-[3px]">
                  <div className="text-[10px] text-[var(--muted-2)] num text-right pr-2" style={{ width: 46 }}>
                    {cleanLaps[li].time.toFixed(2)}
                  </div>
                  {row.map((v, zi) => {
                    const t = Math.max(-1, Math.min(1, v / scale));
                    const bg = t > 0
                      ? `rgba(255,107,107,${0.12 + 0.72 * t})`
                      : `rgba(81,207,102,${0.12 + 0.72 * -t})`;
                    return (
                      <div key={zi}
                        onMouseEnter={() => setHover({ d: d.id, lap: cleanLaps[li].index, zone: zi, v })}
                        onMouseLeave={() => setHover(null)}
                        title={`Круг ${cleanLaps[li].index} · ${a.zones[zi].corner.name} · ${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)} с`}
                        className="rounded-[3px] cursor-default transition-transform hover:scale-110"
                        style={{ width: 30, height: 15, background: bg }} />
                    );
                  })}
                  {hover?.d === d.id && hover.lap === cleanLaps[li].index && (
                    <span className="text-[10px] text-[var(--muted)] num pl-2 whitespace-nowrap">
                      {a.zones[hover.zone].corner.name} {hover.v >= 0 ? '+' : '−'}{Math.abs(hover.v).toFixed(3)} с
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="text-[10px] text-[var(--muted-2)] mt-2 num">
            слева — время круга, с · шкала ±{scale.toFixed(3)} с
          </div>
        </div>
      ))}
    </div>
  );
}

function percentile(a: number[], p: number) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}
