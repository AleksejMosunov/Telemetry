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
    () => noiseFloor(ref, a.corners, a.grid, a.track.length, mode),
    [a, ref, mode],
  );

  const D = (c: PullCell) => (mode === 'best' ? c.distBest : c.dist);
  // Опорный всегда есть среди колонок, но если набор сравнения по какой-то
  // причине его не содержит, первая колонка — честная замена молчаливому падению.
  const refK = Math.max(0, cmp.findIndex(d => d.id === ref.id));
  const total = (k: number) => (mode === 'best' ? rep.totals[k]?.distBest : rep.totals[k]?.dist) ?? NaN;

  // Проценты дистанции сами по себе ни о чём не говорят: пилот думает секундами
  // за круг. Потери на зачётных разгонах, сложенные вместе, сразу показывают,
  // какую часть отставания объясняет тяга, а какая осталась на повороты.
  const scoredRows = rep.rows.filter(r => r.gate && !r.skip && (rep.scope === 'all' || r.clean));
  const lossOf = (d: typeof cmp[0]) => {
    const k = cmp.indexOf(d);
    let dt = 0;
    for (const r of scoredRows) {
      const t = mode === 'best' ? r.cells[k].timeBest : r.cells[k].time;
      const tr = mode === 'best' ? r.cells[refK].timeBest : r.cells[refK].time;
      if (isFinite(t) && isFinite(tr)) dt += t - tr;
    }
    return dt;
  };

  const verdicts = cmp
    .filter(d => d.id !== ref.id)
    .map(d => ({ d, v: verdict(rep, ref.id, d.id, mode), dt: lossOf(d) }));

  return (
    <div className="flex flex-col gap-3">

      <div className="panel p-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[13px] font-medium">Разгон</div>
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
          {verdicts.map(({ d, v, dt }) => (
            <div key={d.id} className="panel p-4">
              <div className="flex items-start gap-3">
                <span className="w-2 h-2 rounded-full mt-2 shrink-0" style={{ background: color(d) }} />
                <div className="min-w-0">
                  {/* Ответ идёт первым и в секундах: проценты дистанции разгона
                      пилоту ничего не говорят, а полсекунды за круг — говорят. */}
                  <div className="text-[15px] font-medium">{v.title}</div>
                  <div className="text-[12px] text-[var(--muted)] mt-0.5">
                    {isFinite(dt) && Math.abs(dt) > 0.001 ? (
                      <>Карт «{name(d)}» {dt > 0 ? 'теряет' : 'выигрывает'}{' '}
                        <span className="num" style={{ color: dt > 0 ? 'var(--bad)' : 'var(--good)' }}>
                          {Math.abs(dt).toFixed(2)} с
                        </span> за круг на разгонах.
                      </>
                    ) : <>Сравнение с «{name(ref)}».</>}
                  </div>
                  <div className="text-[12px] mt-2 leading-relaxed max-w-[720px]">{v.why}</div>
                  {v.action && (
                    <div className="text-[12px] mt-1.5 leading-relaxed max-w-[720px]">
                      <span className="text-[var(--muted)]">Что делать: </span>{v.action}
                    </div>
                  )}
                  {v.note && (
                    <div className="text-[11px] text-[var(--muted)] mt-2 leading-relaxed max-w-[720px]">
                      {v.note}
                    </div>
                  )}

                  <details className="mt-3 text-[11px] group">
                    <summary className="text-[var(--muted-2)] hover:text-[var(--text)] cursor-pointer select-none">
                      как это посчитано
                    </summary>
                    <div className="mt-2 flex flex-col gap-2 text-[var(--muted)] leading-relaxed">
                      {v.points.length > 1 && (
                        <div className="flex items-center gap-2 flex-wrap num">
                          <span className="text-[var(--muted-2)]">насколько длиннее разгон:</span>
                          {v.points.map((p, i) => (
                            <span key={p.label} className="flex items-center gap-2">
                              {i > 0 && <span className="text-[var(--muted-2)]">→</span>}
                              <span className="px-1.5 py-0.5 rounded bg-[var(--panel-2)]">
                                <span className="text-[var(--muted-2)]">{p.gate} км/ч</span>
                                <span className="ml-1.5" style={{ color: p.rel > 0 ? 'var(--bad)' : 'var(--good)' }}>
                                  {p.rel > 0 ? '+' : '−'}{Math.abs(p.rel).toFixed(1)}%
                                </span>
                                <span className="ml-1 text-[var(--muted-2)]">±{p.err.toFixed(1)}</span>
                              </span>
                            </span>
                          ))}
                        </div>
                      )}
                      <div>
                        Растёт слева направо — мотор или лишнее трение. Ровно — лишняя масса.
                        Падает — низы: карбюратор, сцепление. Наклон считается настоящим, только
                        если он крупнее погрешности крайних значений.
                      </div>
                      {isFinite(floor) && (
                        <div>
                          Шумовой пол — {floor.toFixed(1)}%: настолько расходятся две половины кругов
                          опорного заезда, где карт заведомо один и тот же. Среднее отставание тут{' '}
                          {Math.abs(v.pct).toFixed(1)}% — {Math.abs(v.pct) > floor * 2
                            ? 'заметно крупнее, на него можно опираться.'
                            : 'сопоставимо с ним, вывод делать рано.'}
                        </div>
                      )}
                    </div>
                  </details>
                </div>
              </div>
            </div>
          ))}

          <div className="panel overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-[12px] num border-collapse">
                <thead>
                  <tr className="text-[var(--muted)] text-[11px]">
                    <th className="text-left font-normal px-4 py-2 sticky left-0 bg-[var(--panel)]">участок</th>
                    <th className="text-right font-normal px-3 py-2" title="Длина участка от апекса до апекса следующего поворота. Сам разгон меряется внутри него и всегда короче: он начинается на низшей точке скорости и держится в пределах прямой части.">
                      длина
                    </th>
                    <th className="text-right font-normal px-3 py-2" title="Диапазон скоростей, в котором меряется разгон. Считается из данных: снизу — самая высокая скорость выхода среди сравниваемых, сверху — самая низкая пиковая. Всё, что за его пределами, проезжают не все.">
                      ворота
                    </th>
                    <th className="text-right font-normal px-3 py-2" title="Боковая нагрузка на разгоне у каждого участника, посчитанная из радиуса траектории и скорости. Низкая и одинаковая — все едут почти прямо, и разгон ограничен мотором. Высокая — карт ещё в дуге. Разная — кто-то уже распрямился, а кто-то тянет дугу, и тогда сравниваются траектории, а не тяга.">
                      нагрузка
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
                    // Померенный, но не вошедший в итог участок остаётся в таблице:
                    // спрятать его значило бы скрыть, что там разница есть.
                    const counted = !off && (rep.scope === 'all' || r.clean);
                    return (
                      <tr key={r.section.id}
                        onMouseEnter={() => ctx.setCursorS(r.section.sStart)}
                        onMouseLeave={() => ctx.setCursorS(null)}
                        className={`border-t border-[var(--line-soft)] ${off ? 'text-[var(--muted-2)]' : counted ? '' : 'opacity-60'}`}>
                        <td className="px-4 py-2 sticky left-0 bg-inherit whitespace-nowrap">
                          {r.section.label}
                        </td>
                        <td className="px-3 py-2 text-right text-[var(--muted)]">
                          {r.section.length.toFixed(0)}
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          {r.gate
                            ? <span className="text-[var(--muted)]">{r.gate.vLo}→{r.gate.vHi} км/ч</span>
                            : <span className="text-[var(--muted-2)]">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap"
                          title={r.cells.filter(c => isFinite(c.latG))
                            .map(c => `${name(cmp.find(d => d.id === c.driverId)!)}: ${c.latG.toFixed(2)} g`)
                            .join('\n')}>
                          {isFinite(r.latG) ? (
                            <span className={r.clean ? 'text-[var(--muted)]' : 'text-[var(--muted-2)]'}>
                              {/* Когда участники нагружают карт по-разному, одна средняя цифра
                                  прячет ровно то, из-за чего участок и негоден. */}
                              {r.latSpread > 0.02
                                ? `${Math.min(...r.cells.map(c => c.latG)).toFixed(2)}–${Math.max(...r.cells.map(c => c.latG)).toFixed(2)}`
                                : r.latG.toFixed(2)} g
                              {!r.clean && (
                                <span className="ml-1 text-[10px]">
                                  {r.latSpread > 0.08 ? 'по-разному' : 'в дуге'}
                                </span>
                              )}
                            </span>
                          ) : <span className="text-[var(--muted-2)]">—</span>}
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
                        по {rep.scored} {rep.scored === 1 ? 'участку' : 'участкам'}
                        {rep.scope === 'clean'
                          ? ' без нагрузки'
                          : rep.used > rep.scored ? '' : ''}
                        {rep.scope === 'all' && rep.used > 1 && ' — чистых не нашлось, считаем по всем'}
                        {rep.scope === 'clean' && rep.used > rep.scored
                          && `; ${rep.used - rep.scored} в дуге не в счёт`}
                      </span>
                    </td>
                    <td /><td /><td />
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
              Участок разгона — от низшей точки скорости в повороте до пика перед следующим торможением;
              ворота при этом держатся внутри прямой части, поэтому скоростная дуга в конце не портит
              замер и не выбрасывает участок целиком. Участки без общего диапазона скоростей в зачёт не
              идут: там мерить нечего. Про мотор судят участки с низкой боковой нагрузкой; там, где карт
              всю дорогу в дуге, в дистанцию входит и траектория. Из телеметрии видно тягу на массу, а не мощность — разницу между слабым мотором
              и пилотом на десять килограммов тяжелее по этим данным не различить.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
