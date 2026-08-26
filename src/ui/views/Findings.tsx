import { useMemo } from 'react';
import type { ViewCtx } from '../App';
import type { DriverResult } from '../../core/pipeline';
import { buildInsights, type Insight } from '../insights';
import { lapTime, delta, num } from '../format';

const KIND: Record<Insight['kind'], { label: string; color: string }> = {
  key: { label: 'главное', color: '#ffd43b' },
  pattern: { label: 'закономерность', color: '#4dabf7' },
  note: { label: 'наблюдение', color: '#8791a4' },
  caveat: { label: 'оговорка', color: '#ff922b' },
};

export function Findings({ ctx }: { ctx: ViewCtx }) {
  const { a, ref, name, color, Z } = ctx;
  const items = useMemo(() => buildInsights(a, ctx.refId, ctx.name), [a, ctx.refId, ctx.name]);
  const others = a.drivers.filter(d => d.id !== ref.id);

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_330px] items-start">
      <div className="flex flex-col gap-3">
        <Headline ctx={ctx} />

        {items.length === 0 && (
          <div className="panel p-6 text-[13px] text-[var(--muted)]">
            Заметных отличий не нашлось — либо заезд один, либо пилоты едут очень похоже.
          </div>
        )}

        {items.map((it, i) => {
          const k = KIND[it.kind];
          return (
            <div key={i} className="panel p-4 pl-5 relative overflow-hidden">
              <span className="absolute left-0 inset-y-0 w-[3px]" style={{ background: k.color, opacity: 0.7 }} />
              <div className="text-[10px] uppercase tracking-wide mb-1.5" style={{ color: k.color }}>
                {k.label}
              </div>
              <div className="text-[14px] font-medium mb-1 leading-snug">{it.title}</div>
              <div className="text-[13px] text-[var(--muted)] leading-relaxed">{it.body}</div>
            </div>
          );
        })}

        <div className="panel p-4 text-[11px] text-[var(--muted-2)] leading-relaxed">
          Выводы строятся только на связях, которые подтверждаются кругами самой сессии.
          Где связь измерена, но причинность не доказана — это сказано прямо в тексте.
          Приложение не знает про трафик, погоду и состояние техники, поэтому последнее слово за вами.
        </div>
      </div>

      <div className="flex flex-col gap-3 xl:sticky xl:top-[122px]">
        <div className="panel p-4">
          <div className="text-[13px] font-medium mb-3">Сводка</div>
          <table className="w-full text-[12px] num">
            <thead>
              <tr className="text-[10px] text-[var(--muted-2)]">
                <th className="text-left font-normal pb-1.5">пилот</th>
                <th className="text-right font-normal pb-1.5">круг</th>
                <th className="text-right font-normal pb-1.5"
                  title="Насколько круги разбросаны вокруг обычного">разброс</th>
              </tr>
            </thead>
            <tbody>
              {[...a.drivers].sort((p, q) => p.stats.median - q.stats.median).map(d => (
                <tr key={d.id} className="border-t border-[var(--line-soft)]">
                  <td className="py-1.5">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color(d) }} />
                      <span className="truncate max-w-[110px]">{name(d)}</span>
                    </span>
                  </td>
                  <td className="py-1.5 text-right">
                    {lapTime(d.stats.median)}
                    {d.id !== ref.id && (
                      <span className="text-[10px] text-[var(--muted)] ml-1">
                        {delta(d.stats.median - ref.stats.median, 2)}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 text-right text-[var(--muted)]">±{d.stats.sd.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-[10px] text-[var(--muted-2)] mt-2 leading-relaxed">
            Круг — медианный, то есть обычный, а не лучший. Разброс — насколько круги
            разлетаются вокруг него: в двух третях кругов пилот укладывается в эту величину.
          </div>
        </div>

        {others.map(d => {
          const losses = a.zones
            .map((z, i) => ({ z, dt: Z(d)[i].tZone - Z(ref)[i].tZone }))
            .sort((p, q) => q.dt - p.dt)
            .filter(l => l.dt > 0.02)
            .slice(0, 4);
          if (!losses.length) return null;
          const max = losses[0].dt;
          return (
            <div key={d.id} className="panel p-4">
              <div className="flex items-center gap-1.5 text-[13px] font-medium mb-1">
                <span className="w-2 h-2 rounded-full" style={{ background: color(d) }} />
                <span className="truncate">{name(d)}</span>
              </div>
              <div className="text-[11px] text-[var(--muted)] mb-2.5">
                С чего начинать — повороты по величине потери
              </div>
              {losses.map(l => (
                <div key={l.z.corner.id} className="flex items-center gap-2 py-1 text-[12px] num">
                  <span className="w-8">{l.z.corner.name}</span>
                  <span className="flex-1 h-1.5 rounded-full bg-[var(--line-soft)] overflow-hidden">
                    <span className="block h-full rounded-full"
                      style={{ width: `${(l.dt / max) * 100}%`, background: 'var(--bad)', opacity: 0.6 }} />
                  </span>
                  <span className="text-[var(--bad)] w-12 text-right">{delta(l.dt)}</span>
                </div>
              ))}
              <div className="text-[10px] text-[var(--muted-2)] mt-2">
                Вместе {losses.reduce((p, q) => p + q.dt, 0).toFixed(3)} с
                из {(d.stats.median - ref.stats.median).toFixed(3)} с отставания
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Один абзац, который отвечает на вопрос «и что?». */
function Headline({ ctx }: { ctx: ViewCtx }) {
  const { a, ref, name, Z, V } = ctx;
  const others = a.drivers.filter(d => d.id !== ref.id);

  if (!others.length) {
    const d = ref;
    return (
      <div className="panel p-5" style={{ background: 'rgba(255,212,59,0.06)' }}>
        <div className="text-[11px] text-[var(--muted)] mb-1">Итог</div>
        <div className="text-[15px] leading-relaxed">
          <b>{name(d)}</b>: обычный круг <span className="num">{lapTime(d.stats.median)}</span>,
          лучший <span className="num">{lapTime(d.stats.best)}</span>, разброс{' '}
          <span className="num">±{d.stats.sd.toFixed(3)} с</span>. За круг проезжает{' '}
          <span className="num">{num(d.stats.medianPath)} м</span>.
          {Math.abs(d.stats.drift) > 0.12 && (
            <> По ходу стинта {d.stats.drift < 0 ? 'разгонялся' : 'сдавал'} на{' '}
              <span className="num">{Math.abs(d.stats.drift).toFixed(3)} с</span>.</>
          )}
          {' '}Загрузите второй заезд, чтобы получить сравнение.
        </div>
      </div>
    );
  }

  const slowest = others.reduce((p, q) => (p.stats.median >= q.stats.median ? p : q));
  const gap = slowest.stats.median - ref.stats.median;
  const dPath = slowest.stats.medianPath - ref.stats.medianPath;
  const N = a.grid.length;
  let exitWorse = 0;
  for (const c of a.corners) {
    if (V(slowest)[Math.round(c.sEnd) % N] < V(ref)[Math.round(c.sEnd) % N] - 0.15) exitWorse++;
  }
  const top = a.zones
    .map((z, i) => ({ z, dt: Z(slowest)[i].tZone - Z(ref)[i].tZone }))
    .sort((p, q) => q.dt - p.dt).slice(0, 2).filter(l => l.dt > 0.02);

  return (
    <div className="panel p-5" style={{ background: 'rgba(255,212,59,0.06)' }}>
      <div className="text-[11px] text-[var(--muted)] mb-1">Итог</div>
      <div className="text-[15px] leading-relaxed">
        <b>{name(slowest)}</b> медленнее <b>{name(ref)}</b> на{' '}
        <span className="num">{gap.toFixed(3)} с</span> в обычном круге.
        {Math.abs(dPath) > 2 && (
          <> Главное измеримое отличие — траектория{' '}
            {dPath > 0 ? 'длиннее' : 'короче'} на{' '}
            <span className="num">{Math.abs(dPath).toFixed(1)} м</span> за круг.</>
        )}
        {exitWorse / a.corners.length >= 0.65 && (
          <> Теряет на выходе из <span className="num">{exitWorse}</span> поворотов
            из <span className="num">{a.corners.length}</span> — значит дело не в одном месте,
            а в том, как строится выход.</>
        )}
        {top.length > 0 && (
          <> Начинать стоит с {top.map(t => t.z.corner.name).join(' и ')}.</>
        )}
      </div>
    </div>
  );
}
