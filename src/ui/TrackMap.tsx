import { useEffect, useRef } from 'react';
import type { Analysis } from '../core/pipeline';

export type MapMode = 'speed' | 'delta' | 'lines';

interface Props {
  a: Analysis;
  mode: MapMode;
  /** значение на метр для раскраски (скорость опорного пилота или дельта) */
  values: Float64Array;
  /** траектории пилотов: боковое смещение на метр + цвет */
  lines?: Array<{ lat: Float64Array; color: string; width?: number }>;
  cursorS: number | null;
  height?: number;
  onHover?: (s: number | null) => void;
}

/** Точка реальной траектории = осевая линия + боковое смещение по нормали. */
function normalAt(a: Analysis, i: number): [number, number] {
  const n = a.track.n;
  const j = (i + 1) % n, k = (i - 1 + n) % n;
  const ex = a.track.x[j] - a.track.x[k], ey = a.track.y[j] - a.track.y[k];
  const L = Math.hypot(ex, ey) || 1;
  return [-ey / L, ex / L];
}

const speedColor = (f: number) => {
  const stops: Array<[number, number[]]> = [
    [0.0, [56, 92, 214]], [0.35, [46, 170, 190]],
    [0.6, [80, 200, 110]], [0.8, [235, 200, 70]], [1.0, [240, 90, 70]],
  ];
  const t = Math.max(0, Math.min(1, f));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [p0, c0] = stops[i - 1], [p1, c1] = stops[i];
      const u = (t - p0) / (p1 - p0);
      return `rgb(${c0.map((c, k) => Math.round(c + (c1[k] - c) * u)).join(',')})`;
    }
  }
  return 'rgb(240,90,70)';
};

const deltaColorRamp = (d: number, scale: number) => {
  const t = Math.max(-1, Math.min(1, d / scale));
  return t > 0
    ? `rgb(${Math.round(120 + 135 * t)},${Math.round(110 - 40 * t)},${Math.round(110 - 40 * t)})`
    : `rgb(${Math.round(100 + 40 * t)},${Math.round(150 - 60 * t)},${Math.round(110 + 20 * t)})`;
};

export function TrackMap({ a, mode, values, lines, cursorS, height = 420, onHover }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cv = ref.current, wrap = box.current;
    if (!cv || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth, H = height;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const { x, y, n } = a.track;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, x[i]); maxX = Math.max(maxX, x[i]);
      minY = Math.min(minY, y[i]); maxY = Math.max(maxY, y[i]);
    }
    const pad = 34;
    const sc = Math.min((W - 2 * pad) / (maxX - minX), (H - 2 * pad) / (maxY - minY));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const px = (v: number) => W / 2 + (v - cx) * sc;
    const py = (v: number) => H / 2 - (v - cy) * sc;

    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < values.length; i++) {
      if (!isFinite(values[i])) continue;
      lo = Math.min(lo, values[i]); hi = Math.max(hi, values[i]);
    }
    const span = hi - lo || 1;
    const dScale = Math.max(Math.abs(lo), Math.abs(hi)) || 1;

    // основная линия трассы
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const baseW = mode === 'lines' ? 13 : 10;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const vi = values[Math.min(i, values.length - 1)];
      ctx.strokeStyle = mode === 'lines' ? '#1e2430'
        : mode === 'delta' ? deltaColorRamp(vi, dScale)
        : speedColor((vi - lo) / span);
      ctx.lineWidth = baseW;
      ctx.beginPath();
      ctx.moveTo(px(x[i]), py(y[i]));
      ctx.lineTo(px(x[j]), py(y[j]));
      ctx.stroke();
    }

    // реальные траектории пилотов
    if (mode === 'lines' && lines) {
      for (const ln of lines) {
        ctx.strokeStyle = ln.color;
        ctx.lineWidth = ln.width ?? 2.2;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const [nx, ny] = normalAt(a, i);
          const off = ln.lat[Math.min(i, ln.lat.length - 1)] || 0;
          const X = px(x[i] + nx * off), Y = py(y[i] + ny * off);
          i === 0 ? ctx.moveTo(X, Y) : ctx.lineTo(X, Y);
        }
        ctx.closePath();
        ctx.stroke();
      }
    }

    // номера поворотов, отнесённые наружу от центра трассы
    ctx.font = '600 11px ui-sans-serif, system-ui';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const c of a.corners) {
      const i = Math.round(c.sApex) % n;
      const ax = px(x[i]), ay = py(y[i]);
      const dx = x[i] - cx, dy = y[i] - cy;
      const L = Math.hypot(dx, dy) || 1;
      const ox = ax + (dx / L) * 26, oy = ay - (dy / L) * 26;
      ctx.strokeStyle = '#39414f'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ox, oy); ctx.stroke();
      ctx.fillStyle = '#12161e';
      ctx.beginPath(); ctx.arc(ox, oy, 11, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#4d566a'; ctx.stroke();
      ctx.fillStyle = '#cfd7e5';
      ctx.fillText(String(c.id), ox, oy + 0.5);
    }

    // старт/финиш
    const [snx, sny] = normalAt(a, 0);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(px(x[0] + snx * 6), py(y[0] + sny * 6));
    ctx.lineTo(px(x[0] - snx * 6), py(y[0] - sny * 6));
    ctx.stroke();

    // курсор, синхронный с графиками
    if (cursorS != null) {
      const i = Math.round(cursorS) % n;
      if (i >= 0 && isFinite(i)) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(px(x[i]), py(y[i]), 5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#0a0c10'; ctx.lineWidth = 2; ctx.stroke();
      }
    }
  }, [a, mode, values, lines, cursorS, height]);

  return (
    <div ref={box} style={{ width: '100%' }}>
      <canvas
        ref={ref}
        onMouseLeave={() => onHover?.(null)}
        style={{ display: 'block', cursor: onHover ? 'crosshair' : 'default' }}
      />
    </div>
  );
}
