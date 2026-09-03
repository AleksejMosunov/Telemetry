import { useMemo, useState } from 'react';
import type { ViewCtx } from '../App';
import { buildPulls, verdict, noiseFloor, type PullMode, type PullCell } from '../../core/engine';
import { num } from '../format';

const MODES: Array<[PullMode, string, string]> = [
  ['median', 'обычный разгон', 'Медиана по кругам: сколько метров уходит на разгон в среднем. Мерит карт вместе с тем, как его везли.'],
  ['best', 'лучший разгон', 'Десятая часть лучших кругов: на что карт способен, когда пилот в полном газу с самого выхода. Если разрыв держится и здесь, манера ни при чём — дело в самом карте.'],
];

export function Pulls({ ctx }: { ctx: ViewCtx }) {
  const { a, cmp, ref, name, color } = ctx;
  const [mode, setMode] = useState<PullMode>('median');

  const rep = useMemo(
    () => buildPulls(cmp, a.corners, a.grid, a.track.length),
    [a, cmp],
  );
  const floor = useMemo(
    () => noiseFloor(ref, a.corners, a.grid, a.track.length),
    [a, ref],
  );

  const D = (c: PullCell) => (mode === 'best' ? c.distBest : c.dist);
  // Опорный всегда есть среди колонок, но если набор сравнения по какой-то
  // причине его не содержит, первая колонка — честная замена молчаливому падению.
  const refK = Math.max(0, cmp.findIndex(d => d.id === ref.id));
  const total = (k: number) => (mode === 'best' ? rep.totals[k]?.distBest : rep.totals[k]?.dist) ?? NaN;

  const verdicts = cmp
    .filter(d => d.id !== ref.id)
    .map(d => ({ d, v: verdict(rep, ref.id, d.id, mode) }));

  return (
    <div className="flex flex-col gap-3">

      <div className="panel p-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[13px] font-medium">Разгон на прямых</div>
            <div className="text-[11px] text-[var(--muted)] max-w-[640px] leading-relaxed mt-0.5">
              Сколько метров уходит на разгон между двумя скоростями. Скорости фиксированы, поэтому
              разница в выходе из поворота на результат не влияет — сравнивается тяга карта, а не работа
              пилота в повороте. Меньше метров — лучше едет.
            </div>
          </div>
          <div className="flex rounded-lg border border-[var(--line)] overflow-hidden text-[11px] shrink-0">
            {MODES.map(([m, label]) => (
              <button key={m} onClick={() => setMode(m)}
                className={`px-2.5 py-1 transition whitespace-nowrap ${mode === m
                  ? 'bg-[var(--panel-2)]' : 'text-[var(--muted)] hover:text-[var(--text)]'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="text-[11px] text-[var(--muted-2)] mt-2 leading-relaxed max-w-[720px]">
          {MODES.find(([m]) => m === mode)![2]}
        </div>
      </div>

      {rep.used === 0 ? (
        <div className="panel p-4 text-[12px] text-[var(--muted)]">
          Ни одна прямая не годится для замера: у сравниваемых заездов нет общего диапазона скоростей,
          в котором все успевают разогнаться. Такое бывает на очень извилистой трассе или когда заезды
          слишком разные по темпу.
        </div>
      ) : (
        <>
          {verdicts.map(({ d, v }) => (
            <div key={d.id} className="panel p-4 flex items-start gap-3">
              <span className="w-2 h-2 rounded-full mt-1.5 shrink-0" style={{ background: color(d) }} />
              <div className="min-w-0">
                <div className="text-[13px]">
                  <span className="font-medium">{name(d)}</span>
                  <span className="text-[var(--muted)]"> относительно «{name(ref)}»: </span>
                  <span className="num" style={{ color: v.pct > 0 ? 'var(--bad)' : v.pct < 0 ? 'var(--good)' : 'var(--muted)' }}>
                    {v.pct > 0 ? '+' : v.pct < 0 ? '−' : ''}{Math.abs(v.pct).toFixed(1)}%
                  </span>
                  <span className="text-[var(--muted)]"> дистанции разгона</span>
                </div>
                <div className="text-[11px] text-[var(--muted)] mt-0.5 leading-relaxed">{v.text}</div>
                {isFinite(floor) && (
                  <div className="text-[11px] text-[var(--muted-2)] mt-1 leading-relaxed">
                    Шумовой пол метода — <span className="num">{floor.toFixed(1)}%</span>: настолько
                    расходятся между собой две половины кругов опорного заезда, где карт заведомо один
                    и тот же. {Math.abs(v.pct) > floor * 2
                      ? 'Разница крупнее — на неё можно опираться.'
                      : 'Разница сопоставима с ним — вывод делать рано.'}
                  </div>
                )}
              </div>
            </div>
          ))}

          <div className="panel overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-[12px] num border-collapse">
                <thead>
                  <tr className="text-[var(--muted)] text-[11px]">
                    <th className="text-left font-normal px-4 py-2 sticky left-0 bg-[var(--panel)]">прямая</th>
                    <th className="text-right font-normal px-3 py-2">длина</th>
                    <th className="text-right font-normal px-3 py-2" title="Диапазон скоростей, в котором меряется разгон. Считается из данных: снизу — самая высокая скорость выхода среди сравниваемых, сверху — самая низкая пиковая. Всё, что за его пределами, проезжают не все.">
                      ворота
                    </th>
                    {cmp.map(d => (
                      <th key={d.id} className="text-right font-normal px-3 py-2 min-w-[120px] align-bottom">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color(d) }} />
                          <span className="truncate max-w-[150px]">
                            {ctx.nameParts(d).base}<span className="text-[var(--muted-2)]">, м</span>
                          </span>
                        </span>
                        {ctx.nameParts(d).tag && (
                          <span className="block text-[10px] text-[var(--muted-2)] whitespace-nowrap">
                            {ctx.nameParts(d).tag}
                          </span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rep.rows.map(r => {
                    const off = !r.gate || !!r.skip;
                    return (
                      <tr key={r.straight.id}
                        onMouseEnter={() => ctx.setCursorS(r.straight.sStart)}
                        onMouseLeave={() => ctx.setCursorS(null)}
                        className={`border-t border-[var(--line-soft)] ${off ? 'text-[var(--muted-2)]' : ''}`}>
                        <td className="px-4 py-2 sticky left-0 bg-inherit whitespace-nowrap">
                          {r.straight.label}
                        </td>
                        <td className="px-3 py-2 text-right text-[var(--muted)]">
                          {r.straight.length.toFixed(0)}
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          {r.gate
                            ? <span className="text-[var(--muted)]">{r.gate.vLo}→{r.gate.vHi} км/ч</span>
                            : <span className="text-[var(--muted-2)]">—</span>}
                        </td>
                        {off ? (
                          <td className="px-3 py-2 text-[11px] text-[var(--muted-2)]" colSpan={cmp.length}>
                            {r.skip}
                          </td>
                        ) : cmp.map((d, k) => {
                          const c = r.cells[k];
                          const rc = r.cells[refK];
                          const dd = D(c) - D(rc);
                          const isRef = d.id === ref.id;
                          return (
                            <td key={d.id} className="px-3 py-2 text-right whitespace-nowrap">
                              <span className={isRef ? 'text-[var(--muted)]' : 'text-[var(--muted)] mr-1.5'}>
                                {num(D(c), 1)}
                              </span>
                              {!isRef && (
                                <span style={{ color: Math.abs(dd) < 0.05 ? 'var(--muted)' : dd > 0 ? 'var(--bad)' : 'var(--good)' }}>
                                  {dd > 0 ? '+' : '−'}{Math.abs(dd).toFixed(1)}
                                </span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                  <tr className="border-t border-[var(--line)] font-medium">
                    <td className="px-4 py-2.5 sticky left-0 bg-[var(--panel)]">
                      всего
                      <span className="text-[var(--muted-2)] ml-2 text-[10px] font-normal">
                        по {rep.used} {rep.used === 1 ? 'прямой' : 'прямым'}
                      </span>
                    </td>
                    <td /><td />
                    {cmp.map((d, k) => {
                      const dd = total(k) - total(refK);
                      return (
                        <td key={d.id} className="px-3 py-2.5 text-right whitespace-nowrap">
                          <span className="text-[var(--muted)] mr-1.5">{num(total(k), 1)}</span>
                          {d.id !== ref.id && (
                            <span style={{ color: dd > 0 ? 'var(--bad)' : 'var(--good)' }}>
                              {dd > 0 ? '+' : '−'}{Math.abs(dd).toFixed(1)}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 text-[11px] text-[var(--muted-2)] leading-relaxed border-t border-[var(--line-soft)] max-w-[760px]">
              Короткие прямые и прямые без общего диапазона скоростей в зачёт не идут: там мерить нечего.
              Из телеметрии видно тягу на массу, а не мощность — разницу между слабым мотором и пилотом
              на десять килограммов тяжелее по этим данным не различить.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
