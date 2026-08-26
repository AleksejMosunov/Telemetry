import { useMemo } from 'react';
import type { ViewCtx } from '../App';
import { buildInsights, type Insight } from '../insights';

const STYLE: Record<Insight['kind'], { label: string; color: string; bg: string }> = {
  key: { label: 'главное', color: '#ffd43b', bg: 'rgba(255,212,59,0.09)' },
  pattern: { label: 'закономерность', color: '#4dabf7', bg: 'rgba(77,171,247,0.09)' },
  note: { label: 'наблюдение', color: '#8791a4', bg: 'rgba(135,145,164,0.07)' },
  caveat: { label: 'оговорка', color: '#ff922b', bg: 'rgba(255,146,43,0.08)' },
};

export function Findings({ ctx }: { ctx: ViewCtx }) {
  const items = useMemo(
    () => buildInsights(ctx.a, ctx.refId, ctx.name),
    [ctx.a, ctx.refId, ctx.name],
  );

  return (
    <div className="flex flex-col gap-3 max-w-[900px]">
      <div className="panel p-4">
        <div className="text-[13px] font-medium">Что видно в данных</div>
        <div className="text-[11px] text-[var(--muted)]">
          Выводы построены только на связях, которые подтверждаются кругами самой сессии.
          Там, где связь измерена, но не доказана, это отмечено прямо в тексте.
        </div>
      </div>

      {items.length === 0 && (
        <div className="panel p-6 text-[13px] text-[var(--muted)]">
          Заметных отличий не нашлось — либо заезд один, либо пилоты едут очень похоже.
        </div>
      )}

      {items.map((it, i) => {
        const s = STYLE[it.kind];
        return (
          <div key={i} className="panel p-4" style={{ background: s.bg }}>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded"
                style={{ color: s.color, border: `1px solid ${s.color}44` }}>{s.label}</span>
            </div>
            <div className="text-[14px] font-medium mb-1 leading-snug">{it.title}</div>
            <div className="text-[13px] text-[var(--muted)] leading-relaxed">{it.body}</div>
          </div>
        );
      })}
    </div>
  );
}
