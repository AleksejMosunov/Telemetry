import { useEffect, useRef } from 'react';
import uPlot from 'uplot';

/** Зона на оси X: поворот на графике по дистанции, фаза в детали поворота. */
export interface ChartBand {
  from: number;
  to: number;
  label: string;
  /** уточнение для подсказки: «левый», «правый» */
  sub?: string;
}

export interface ChartProps {
  data: uPlot.AlignedData;
  series: uPlot.Series[];
  height: number;
  yLabel?: string;
  /** зоны поворотов для подсветки фона */
  bands?: ChartBand[];
  /** подписи зон отдельной осью сверху — номера поворотов над графиком */
  bandAxis?: boolean;
  syncKey?: string;
  onCursor?: (x: number | null) => void;
  yRange?: (min: number, max: number) => [number, number];
  /** формат значения в подсказке у курсора */
  fmt?: (v: number) => string;
  /** единица оси X для заголовка подсказки */
  xUnit?: string;
  /** заголовок подсказки целиком вместо «значение + единица» */
  xFmt?: (v: number) => string;
}

const defFmt = (v: number) =>
  Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
const fmtX = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : String(v));
const strokeOf = (u: uPlot, s: uPlot.Series, i: number) =>
  typeof s.stroke === 'function' ? String(s.stroke(u, i)) : String(s.stroke ?? '#8791a4');

export function Chart({
  data, series, height, yLabel, bands, bandAxis, syncKey, onCursor, yRange, fmt, xUnit, xFmt,
}: ChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  // всё, что меняется чаще набора серий, держим в ref — иначе график пересоздаётся зря
  const cb = useRef(onCursor); cb.current = onCursor;
  const bandsRef = useRef(bands); bandsRef.current = bands;
  const dataRef = useRef(data); dataRef.current = data;
  const fmtRef = useRef(fmt ?? defFmt); fmtRef.current = fmt ?? defFmt;
  const xUnitRef = useRef(xUnit); xUnitRef.current = xUnit;
  const xFmtRef = useRef(xFmt); xFmtRef.current = xFmt;
  const firstBands = useRef(true);
  const seriesRef = useRef(series); seriesRef.current = series;
  const yRangeRef = useRef(yRange); yRangeRef.current = yRange;
  // identity series меняется на каждое движение курсора (ctx пересобирается),
  // а пересоздание графика на каждый mousemove — это рывки и прыжок курсора в начало
  const seriesKey = series.map(s => [
    typeof s.label === 'string' ? s.label : '',
    String(s.stroke ?? ''), s.width ?? '', (s.dash ?? []).join(','), s.show === false ? 0 : 1,
  ].join('|')).join(';');

  useEffect(() => {
    if (!host.current) return;
    const el = host.current;

    // подсказка и подсветка активной зоны живут внутри .u-over — координаты курсора там же
    const tip = document.createElement('div');
    tip.className = 'u-tip u-off';
    const hl = document.createElement('div');
    hl.className = 'u-band-hl u-off';
    let over = false;

    const drawBands = (u: uPlot) => {
      const bs = bandsRef.current;
      if (!bs?.length) return;
      const { ctx } = u;
      ctx.save();
      for (const b of bs) {
        const x0 = u.valToPos(b.from, 'x', true);
        const x1 = u.valToPos(b.to, 'x', true);
        ctx.fillStyle = 'rgba(255,255,255,0.032)';
        ctx.fillRect(x0, u.bbox.top, x1 - x0, u.bbox.height);
      }
      ctx.restore();
    };

    const updateTip = (u: uPlot, idx: number | null) => {
      if (idx == null) { tip.classList.add('u-off'); hl.classList.add('u-off'); return; }
      const xv = u.data[0][idx] as number;
      const b = bandsRef.current?.find(z => xv >= z.from && xv <= z.to) ?? null;

      if (b) {
        const x0 = u.valToPos(b.from, 'x');
        const x1 = u.valToPos(b.to, 'x');
        hl.style.left = `${x0}px`;
        hl.style.width = `${Math.max(1, x1 - x0)}px`;
        hl.classList.remove('u-off');
      } else hl.classList.add('u-off');

      // подсказку показываем только у графика под мышью, а не у всех синхронизированных
      if (!over) { tip.classList.add('u-off'); return; }

      tip.textContent = '';
      const head = document.createElement('div');
      head.className = 'u-tip-h';
      head.append(xFmtRef.current
        ? xFmtRef.current(xv)
        : `${fmtX(xv)}${xUnitRef.current ? ` ${xUnitRef.current}` : ''}`);
      if (b) {
        const tag = document.createElement('span');
        tag.className = 'u-tip-b';
        tag.textContent = b.sub ? `${b.label} · ${b.sub}` : b.label;
        head.append(' · ', tag);
      }
      tip.append(head);

      for (let si = 1; si < u.series.length; si++) {
        const s = u.series[si];
        if (s.show === false) continue;
        const v = u.data[si][idx] as number | null;
        const row = document.createElement('div');
        row.className = 'u-tip-r';
        const dot = document.createElement('i');
        dot.style.background = strokeOf(u, s, si);
        const nm = document.createElement('span');
        nm.className = 'u-tip-n';
        nm.textContent = typeof s.label === 'string' ? s.label : '';
        const val = document.createElement('b');
        val.textContent = v == null || !isFinite(v) ? '—' : fmtRef.current(v);
        row.append(dot, nm, val);
        tip.append(row);
      }

      tip.classList.remove('u-off');
      const left = u.cursor.left ?? 0;
      const w = tip.offsetWidth;
      const ow = u.over.clientWidth;
      let x = left + 14;
      if (x + w > ow - 4) x = left - w - 14;
      tip.style.transform = `translate(${Math.round(Math.max(2, Math.min(x, ow - w - 2)))}px, 8px)`;
    };

    const axes: uPlot.Axis[] = [
      {
        stroke: '#8791a4', grid: { stroke: '#1a1f2a', width: 1 },
        ticks: { stroke: '#1a1f2a' }, font: '11px ui-sans-serif, system-ui',
        values: (_u, v) => v.map(x => `${x}`),
      },
      {
        stroke: '#8791a4', grid: { stroke: '#1a1f2a', width: 1 },
        ticks: { stroke: '#1a1f2a' }, font: '11px ui-sans-serif, system-ui',
        label: yLabel, labelFont: '11px ui-sans-serif, system-ui', labelSize: 22,
        size: 52,
      },
    ];

    if (bandAxis) {
      axes.push({
        scale: 'x', side: 0, size: 19, gap: 3, space: 40,
        stroke: '#9aa6bb', font: '600 11px ui-sans-serif, system-ui',
        grid: { show: false }, ticks: { show: false },
        splits: () => (bandsRef.current ?? []).map(b => (b.from + b.to) / 2),
        // подписи прореживаем по месту: узкие повороты сливаются в кашу
        values: (u, splits) => {
          const bs = bandsRef.current ?? [];
          const sc = u.scales.x;
          const plotW = u.over.clientWidth || u.width;
          const span = (sc?.max ?? 1) - (sc?.min ?? 0);
          let lastPx = -1e9;
          return splits.map((v, i) => {
            const label = bs[i]?.label ?? '';
            if (!label || !(span > 0)) return label || null;
            const px = ((v - (sc!.min as number)) / span) * plotW;
            const need = label.length * 7 + 12;
            if (px - lastPx < need) return null;
            lastPx = px;
            return label;
          });
        },
      });
    }

    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height,
      padding: [bandAxis ? 2 : 12, 12, 0, 0],
      cursor: {
        y: false,
        sync: syncKey ? { key: syncKey, setSeries: false } : undefined,
        points: { size: 6 },
      },
      legend: { show: false },
      scales: {
        x: { time: false },
        y: yRangeRef.current ? { range: (_u, min, max) => yRangeRef.current!(min, max) } : {},
      },
      axes,
      series: seriesRef.current,
      hooks: {
        drawClear: [drawBands],
        ready: [(u: uPlot) => {
          u.over.append(hl, tip);
          u.over.addEventListener('mouseenter', () => { over = true; });
          u.over.addEventListener('mouseleave', () => {
            over = false;
            tip.classList.add('u-off');
            hl.classList.add('u-off');
          });
        }],
        setCursor: [(u: uPlot) => {
          const i = u.cursor.idx ?? null;
          cb.current?.(i == null ? null : (u.data[0][i] as number));
          updateTip(u, i);
        }],
      },
    };

    plot.current = new uPlot(opts, dataRef.current, el);

    // мышь наведена — стрелками можно уточнять позицию по одной точке (Shift — по десять)
    const onKey = (e: KeyboardEvent) => {
      if (!over) return;
      const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
      const u = plot.current;
      if (!dir || !u) return;
      e.preventDefault();
      const n = u.data[0].length;
      if (!n) return;
      const cur = u.cursor.idx ?? 0;
      const next = Math.max(0, Math.min(n - 1, cur + dir * (e.shiftKey ? 10 : 1)));
      // третий аргумент — публикация в sync, чтобы соседние графики шли следом;
      // в типах uPlot его нет, в рантайме есть
      (u.setCursor as (o: { left: number; top: number }, fire?: boolean, pub?: boolean) => void)(
        { left: u.valToPos(u.data[0][next] as number, 'x'), top: u.cursor.top ?? 1 },
        true, true,
      );
    };
    window.addEventListener('keydown', onKey);
    const ro = new ResizeObserver(() => {
      if (plot.current && el.clientWidth) plot.current.setSize({ width: el.clientWidth, height });
    });
    ro.observe(el);
    return () => {
      window.removeEventListener('keydown', onKey);
      ro.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
    // пересоздаём при смене набора серий — данных немного, это дёшево;
    // bands/fmt читаются из ref, поэтому в зависимостях их нет
  }, [seriesKey, height, yLabel, bandAxis, syncKey]);

  useEffect(() => { plot.current?.setData(data); }, [data]);
  // только перерисовка: redraw() без аргумента заново выставляет шкалу x,
  // а на первом проходе она ещё не посчитана — график остаётся пустым
  useEffect(() => {
    if (firstBands.current) { firstBands.current = false; return; }
    plot.current?.redraw(false);
  }, [bands]);


  return <div ref={host} style={{ width: '100%', height }} />;
}
