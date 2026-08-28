import { useMemo, useState } from 'react';
import type uPlot from 'uplot';
import type { ViewCtx } from '../App';
import type { DriverResult } from '../../core/pipeline';
import { TrackMap, MapLegend, type MapMode } from '../TrackMap';
import { Chart } from '../Chart';
import { lapTime, delta, num, deltaColor } from '../format';

const fmtLapNo = (v: number) => `круг ${v}`;
import { deltaRate, sectorsFromCuts } from '../../core/analysis';

/** Кольцевое расстояние по кругу, м. */
const ring = (x: number, y: number, L: number) => {
  const d = Math.abs(x - y) % L;
  return Math.min(d, L - d);
};

export function Overview({ ctx }: { ctx: ViewCtx }) {
  const { a, ref, name, color, V, T } = ctx;
  const [mode, setMode] = useState<MapMode>('speed');
  const [hoverS, setHoverS] = useState<number | null>(null);
  const others = a.drivers.filter(d => d.id !== ref.id);
  const [deltaOf, setDeltaOf] = useState(others[0]?.id ?? ref.id);
  const deltaDriver = a.drivers.find(x => x.id === deltaOf) ?? ref;

  // ── правка границ секторов прямо на карте ────────────────────────────
  const L = a.track.length;
  const [editSec, setEditSec] = useState(false);
  const [saving, setSaving] = useState(false);
  /** черновик держим в индексах зон: сектор всегда из целых зон */
  const [draft, setDraft] = useState<number[]>([]);

  const draftSectors = useMemo(
    () => sectorsFromCuts(a.zones, L, draft.map(i => a.zones[i].sStart / L)),
    [a, draft, L],
  );

  const startEdit = () => {
    setDraft(ctx.sectors.slice(1).map(x => x.from));
    setEditSec(true);
  };

  /** Клик по трассе притягивается к ближайшей границе зоны — это середина прямой. */
  const pickCut = (s: number) => {
    let best = 1, bd = Infinity;
    for (let i = 1; i < a.zones.length; i++) {
      const d = ring(a.zones[i].sStart, s, L);
      if (d < bd) { bd = d; best = i; }
    }
    setDraft(d => (d.includes(best) ? d.filter(x => x !== best) : [...d, best].sort((p, q) => p - q)));
  };

  const applySectors = async (cuts: number[]) => {
    setSaving(true);
    try {
      await ctx.saveSectors(cuts.length ? cuts.map(i => a.zones[i].sStart / L) : null);
      setEditSec(false);
    } finally { setSaving(false); }
  };

  const mapValues = useMemo(
    () => (mode === 'delta' ? deltaRate(T(deltaDriver), T(ref)) : V(ref)),
    [mode, deltaDriver, ref, T, V],
  );

  const range = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const v of mapValues) { if (!isFinite(v)) continue; lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return { lo, hi, absMax: Math.max(Math.abs(lo), Math.abs(hi)) };
  }, [mapValues]);

  /** Подпись у поворота: без чисел карта не читается. */
  const cornerLabel = useMemo(() => {
    if (mode === 'lines') return undefined;
    if (mode === 'speed') {
      return (ci: number) => `${V(ref)[Math.round(a.corners[ci].sApex) % a.grid.length].toFixed(0)}`;
    }
    return (ci: number) => {
      const zi = a.zones.findIndex(z => z.corner.id === a.corners[ci].id);
      if (zi < 0) return null;
      const dt = ctx.Z(deltaDriver)[zi].tZone - ctx.Z(ref)[zi].tZone;
      return `${dt >= 0 ? '+' : '−'}${Math.abs(dt).toFixed(2)}`;
    };
  }, [mode, a, ref, V, ctx, deltaDriver]);

  const lines = useMemo(
    () => a.drivers.map(d => ({ lat: ctx.LAT(d), color: color(d), width: d.id === ref.id ? 2.6 : 2 })),
    [a, ctx, color, ref],
  );

  const lapChart = useMemo(() => {
    const maxLap = Math.max(...a.drivers.map(d => Math.max(...d.laps.filter(l => l.clean).map(l => l.index))));
    const xs: number[] = [];
    for (let i = 1; i <= maxLap; i++) xs.push(i);
    const rows: (number | null)[][] = a.drivers.map(d => {
      const m = new Map(d.laps.filter(l => l.clean).map(l => [l.index, l.time]));
      return xs.map(i => m.get(i) ?? null);
    });
    const series: uPlot.Series[] = [
      { label: 'круг' },
      ...a.drivers.map(d => ({
        label: name(d), stroke: color(d), width: 2,
        points: { show: true, size: 5, fill: color(d), stroke: color(d) },
        spanGaps: false,
      })),
    ];
    return { data: [xs, ...rows] as unknown as uPlot.AlignedData, series };
  }, [a, name, color]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fit,minmax(230px,1fr))` }}>
        {a.drivers.map(d => <DriverCard key={d.id} d={d} ctx={ctx} />)}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
        <div className="panel p-4">
          <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
            <div>
              <div className="text-[13px] font-medium">Трасса</div>
              <div className="text-[11px] text-[var(--muted)] num">
                {a.track.length.toFixed(0)} м · {a.corners.length} поворотов · определена из GPS
              </div>
            </div>
            <div className="flex items-center gap-2">
              {mode === 'delta' && others.length > 1 && (
                <select value={deltaOf} onChange={e => setDeltaOf(e.target.value)}
                  className="bg-[var(--panel-2)] border border-[var(--line)] rounded-lg px-2 py-1 text-[11px] outline-none">
                  {others.map(d => <option key={d.id} value={d.id}>{name(d)}</option>)}
                </select>
              )}
              <button onClick={() => (editSec ? setEditSec(false) : startEdit())}
                title="Задать границы секторов для этой трассы"
                className={`px-2.5 py-1 rounded-lg border text-[11px] transition
                  ${editSec
                    ? 'border-[#5a4a2b] bg-[#191510] text-[#ffd9a0]'
                    : 'border-[var(--line)] text-[var(--muted)] hover:text-[var(--text)]'}`}>
                сектора
              </button>
              <div className="flex rounded-lg border border-[var(--line)] overflow-hidden text-[11px]">
                {([['speed', 'скорость'], ['delta', 'потери'], ['lines', 'траектории']] as const)
                  .filter(([m]) => m !== 'delta' || others.length)
                  .map(([m, label]) => (
                    <button key={m} onClick={() => setMode(m)}
                      className={`px-2.5 py-1 transition ${mode === m ? 'bg-[var(--panel-2)]' : 'text-[var(--muted)] hover:text-[var(--text)]'}`}>
                      {label}
                    </button>
                  ))}
              </div>
            </div>
          </div>
          {editSec && (
            <div className="rounded-lg px-3 py-2 mb-2 text-[12px] leading-relaxed"
              style={{ background: 'rgba(255,212,59,0.07)' }}>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-[var(--muted)]">
                  Клик по трассе ставит или снимает границу сектора. Границу притягивает
                  к ближайшей середине прямой — резать поворот пополам нечем.
                </span>
                <span className="ml-auto flex items-center gap-2">
                  <button disabled={saving} onClick={() => applySectors(draft)}
                    className="px-2.5 py-1 rounded-lg border border-[#5a4a2b] bg-[#191510]
                      text-[#ffd9a0] text-[11px] hover:bg-[#221c12] transition disabled:opacity-40">
                    Сохранить для трассы
                  </button>
                  <button disabled={saving} onClick={() => applySectors([])}
                    title="Вернуть автоматическую разбивку"
                    className="px-2.5 py-1 rounded-lg border border-[var(--line)] text-[11px]
                      text-[var(--muted)] hover:text-[var(--text)] transition disabled:opacity-40">
                    авто
                  </button>
                  <button disabled={saving} onClick={() => setEditSec(false)}
                    className="text-[11px] text-[var(--muted-2)] hover:text-[var(--text)] transition">
                    отмена
                  </button>
                </span>
              </div>
              <div className="num text-[11px] mt-1.5 text-[var(--text)]">
                {draftSectors.map(x => `${x.name} ${x.label}`).join('  ·  ')}
                {ctx.sectorCuts
                  ? <span className="text-[var(--muted-2)]"> · сейчас у трассы свои границы</span>
                  : <span className="text-[var(--muted-2)]"> · сейчас разбивка автоматическая</span>}
              </div>
            </div>
          )}

          <TrackMap a={a} mode={mode} values={mapValues} lines={lines}
            cornerLabel={editSec ? undefined : cornerLabel} cursorS={hoverS ?? ctx.cursorS}
            height={440} onHover={setHoverS}
            marks={editSec
              ? draftSectors.slice(1).map(x => ({ s: x.sStart, label: x.name }))
              : undefined}
            onPick={editSec ? pickCut : undefined} />

          <MapLegend mode={mode} min={range.lo}
            max={mode === 'speed' ? range.hi : range.absMax * 100}
            unit={mode === 'speed' ? 'км/ч' : 'с на 100 м'} />

          <div className="text-[11px] text-[var(--muted-2)] mt-2 min-h-[16px]">
            {hoverS != null ? (
              <span className="num text-[var(--text)]">
                {hoverS} м
                {a.corners.find(c => hoverS >= c.sStart && hoverS <= c.sEnd)
                  && ` · ${a.corners.find(c => hoverS >= c.sStart && hoverS <= c.sEnd)!.name}`}
                {' · '}
                {a.drivers.map(d => `${name(d)} ${V(d)[hoverS].toFixed(1)} км/ч`).join('   ')}
              </span>
            ) : (
              <>
                {mode === 'speed' && `Цвет и числа у поворотов — скорость «${name(ref)}» в апексе, км/ч. Наведите на трассу для точного значения.`}
                {mode === 'delta' && `Красное — где «${name(deltaDriver)}» теряет время относительно «${name(ref)}», зелёное — где выигрывает. Числа у поворотов — потеря в зоне, с.`}
                {mode === 'lines' && `Реальные траектории: осевая линия плюс измеренное боковое смещение.`}
              </>
            )}
          </div>
        </div>

        <div className="panel p-4">
          <div className="text-[13px] font-medium mb-1">Время круга по ходу заезда</div>
          <div className="text-[11px] text-[var(--muted)] mb-2">Только чистые круги; заездной и выбросы отфильтрованы</div>
          <Chart data={lapChart.data} series={lapChart.series} height={392} yLabel="сек"
            fmt={lapTime} xFmt={fmtLapNo} />
        </div>
      </div>
    </div>
  );
}

function DriverCard({ d, ctx }: { d: DriverResult; ctx: ViewCtx }) {
  const { ref, name, color, ghosts, toggleGhost, lapMode } = ctx;
  const isRef = d.id === ref.id;
  const ghostOn = ghosts.includes(d.id);
  const dBest = d.stats.best - ref.stats.best;
  const dPath = d.stats.medianPath - ref.stats.medianPath;
  const clean = d.laps.filter(l => l.clean).length;

  return (
    <div className="panel p-4" style={{ borderColor: isRef ? color(d) + '55' : undefined }}>
      <div className="flex items-center gap-2 mb-3">
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: color(d) }} />
        <span className="text-[13px] font-medium truncate">{name(d)}</span>
      </div>
      <div className="flex items-baseline gap-2 mb-0.5">
        <span className="num text-2xl font-semibold tracking-tight">{lapTime(d.stats.best)}</span>
        {!isRef && (
          <span className="num text-[13px]" style={{ color: deltaColor(dBest) }}>{delta(dBest)}</span>
        )}
      </div>
      <div className="text-[11px] text-[var(--muted-2)] mb-3">лучший круг · {clean} чистых кругов</div>
      <Row label="медиана" value={lapTime(d.stats.median)}
        hint="Время круга, ровно посередине между лучшим и худшим: половина кругов быстрее, половина медленнее. Показывает реальный темп, а не разовую удачу."
        extra={isRef ? null : delta(d.stats.median - ref.stats.median)}
        extraColor={deltaColor(d.stats.median - ref.stats.median)} />
      <Row label="разброс кругов" value={`±${d.stats.sd.toFixed(3)} с`}
        hint={`В двух третях кругов пилот укладывается в ${lapTime(d.stats.median)} плюс-минус ${d.stats.sd.toFixed(3)} с. Меньше — ровнее едет. В статистике эту величину называют сигмой (σ) или стандартным отклонением.`} />
      <Row label="длина траектории" value={`${num(d.stats.medianPath)} м`}
        hint="Сколько метров пилот реально проезжает за круг по своей траектории. Длина осевой линии трассы — для сравнения. Каждый лишний метр это примерно 0.05 с."
        extra={isRef ? null : `${dPath > 0 ? '+' : '−'}${Math.abs(dPath).toFixed(1)} м`}
        extraColor={deltaColor(dPath)} />
      <Row label="темп по стинту"
        value={d.stats.drift < -0.05 ? 'разогнался' : d.stats.drift > 0.05 ? 'сдал' : 'ровно'}
        hint={`Среднее время круга во второй половине стинта минус в первой: ${d.stats.firstHalf.toFixed(3)} → ${d.stats.secondHalf.toFixed(3)} с. Минус — к концу ехал быстрее (раскатался, трасса прогрелась, топливо выгорело). Плюс — сдавал (резина, усталость).`}
        extra={`${d.stats.drift > 0 ? '+' : '−'}${Math.abs(d.stats.drift).toFixed(3)} с`}
        extraColor={d.stats.drift < -0.05 ? 'var(--good)' : d.stats.drift > 0.05 ? 'var(--bad)' : 'var(--muted-2)'} />
      <Row label="пик перегрузки" value={`${num(d.stats.peakG, 2)} g`}
        hint="Наибольшее суммарное ускорение за круг — торможение и поворот вместе. Показывает, насколько пилот готов давить. Одинаковые значения у разных пилотов означают, что дело не в смелости, а в технике." />

      <button
        onClick={() => toggleGhost(d)}
        disabled={lapMode === 'best'}
        title={lapMode === 'best'
          ? 'Уже включён режим «лучший круг» — сравнивать его с самим собой нечем. Переключитесь на усреднённый круг.'
          : 'Ставит лучший круг этого пилота отдельной колонкой рядом с его обычным — в «Поворотах», «Графиках» и «Повторе». В «Обзоре» и «Стабильности» он не появится: там считается по всем кругам заезда.'}
        className={`mt-3 w-full text-[11px] px-2 py-1.5 rounded border transition
          disabled:opacity-40 disabled:cursor-not-allowed
          ${ghostOn
            ? 'border-[var(--muted-2)] bg-[var(--panel-2)] text-[var(--text)]'
            : 'border-[var(--line)] text-[var(--muted)] hover:text-[var(--text)]'}`}>
        {ghostOn ? '− убрать свой лучший круг' : '+ сравнить со своим лучшим кругом'}
      </button>
    </div>
  );
}

function Row({ label, value, extra, extraColor, hint }: {
  label: string; value: string; extra?: string | null; extraColor?: string; hint?: string;
}) {
  return (
    <div className="flex items-center justify-between py-1 text-[12px] border-t border-[var(--line-soft)]"
      title={hint}>
      <span className={`text-[var(--muted)] ${hint ? 'decoration-dotted decoration-[var(--muted-2)] underline underline-offset-[3px] cursor-help' : ''}`}>
        {label}
      </span>
      <span className="num flex items-center gap-1.5">
        {value}
        {extra && <span style={{ color: extraColor ?? 'var(--muted-2)' }} className="text-[11px]">{extra}</span>}
      </span>
    </div>
  );
}
