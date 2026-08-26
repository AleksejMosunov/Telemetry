import { useEffect, useRef } from 'react';
import uPlot from 'uplot';

export interface ChartProps {
  data: uPlot.AlignedData;
  series: uPlot.Series[];
  height: number;
  yLabel?: string;
  /** зоны поворотов для подсветки фона: [начало, конец, подпись] */
  bands?: Array<{ from: number; to: number; label: string }>;
  syncKey?: string;
  onCursor?: (x: number | null) => void;
  yRange?: (min: number, max: number) => [number, number];
}

export function Chart({ data, series, height, yLabel, bands, syncKey, onCursor, yRange }: ChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const cb = useRef(onCursor);
  cb.current = onCursor;

  useEffect(() => {
    if (!host.current) return;
    const el = host.current;

    const drawBands = (u: uPlot) => {
      if (!bands?.length) return;
      const { ctx } = u;
      ctx.save();
      for (const b of bands) {
        const x0 = u.valToPos(b.from, 'x', true);
        const x1 = u.valToPos(b.to, 'x', true);
        ctx.fillStyle = 'rgba(255,255,255,0.032)';
        ctx.fillRect(x0, u.bbox.top, x1 - x0, u.bbox.height);
      }
      ctx.restore();
    };

    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height,
      padding: [12, 12, 0, 0],
      cursor: {
        y: false,
        sync: syncKey ? { key: syncKey, setSeries: false } : undefined,
        points: { size: 6 },
      },
      legend: { show: false },
      scales: {
        x: { time: false },
        y: yRange ? { range: (_u, min, max) => yRange(min, max) } : {},
      },
      axes: [
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
      ],
      series,
      hooks: {
        drawClear: [drawBands],
        setCursor: [(u: uPlot) => {
          const i = u.cursor.idx;
          cb.current?.(i == null ? null : (u.data[0][i] as number));
        }],
      },
    };

    plot.current = new uPlot(opts, data, el);
    const ro = new ResizeObserver(() => {
      if (plot.current && el.clientWidth) plot.current.setSize({ width: el.clientWidth, height });
    });
    ro.observe(el);
    return () => { ro.disconnect(); plot.current?.destroy(); plot.current = null; };
    // пересоздаём при смене набора серий/зон — данных немного, это дёшево
  }, [series, height, yLabel, bands, syncKey, yRange]);

  useEffect(() => { plot.current?.setData(data); }, [data]);

  return <div ref={host} style={{ width: '100%', height }} />;
}
