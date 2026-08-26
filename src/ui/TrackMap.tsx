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
  /** подпись под номером поворота — скорость в апексе, дельта и т.п. */
  cornerLabel?: (cornerIndex: number) => string | null;
  cursorS: number | null;
  height?: number;
  onHover?: (s: number | null) => void;
}

export function normalAt(a: Analysis, i: number): [number, number] {
  const n = a.track.n;
  const j = (i + 1) % n, k = (i - 1 + n) % n;
  const ex = a.track.x[j] - a.track.x[k], ey = a.track.y[j] - a.track.y[k];
  const L = Math.hypot(ex, ey) || 1;
  return [-ey / L, ex / L];
}

const SPEED_STOPS: Array<[number, number[]]> = [
  [0.0, [56, 92, 214]], [0.35, [46, 170, 190]],
  [0.6, [80, 200, 110]], [0.8, [235, 200, 70]], [1.0, [240, 90, 70]],
];

export const speedColor = (f: number) => {
  const t = Math.max(0, Math.min(1, f));
  for (let i = 1; i < SPEED_STOPS.length; i++) {
    if (t <= SPEED_STOPS[i][0]) {
      const [p0, c0] = SPEED_STOPS[i - 1], [p1, c1] = SPEED_STOPS[i];
      const u = (t - p0) / (p1 - p0);
      return `rgb(${c0.map((c, k) => Math.round(c + (c1[k] - c) * u)).join(',')})`;
    }
  }
  return 'rgb(240,90,70)';
};

const NEUTRAL = [104, 112, 126], LOSS = [255, 88, 88], GAIN = [64, 214, 112];

/** Непрерывный расходящийся градиент: нейтральный в нуле, без разрыва посередине. */
export const deltaColor = (d: number, scale: number) => {
  const t = Math.max(-1, Math.min(1, d / (scale || 1)));
  const to = t >= 0 ? LOSS : GAIN;
  const k = Math.abs(t);
  return `rgb(${NEUTRAL.map((c, i) => Math.round(c + (to[i] - c) * k)).join(',')})`;
};

/** Индексы метров, покрывающие зону, с учётом перехода через старт/финиш. */
export function zoneIndices(from: number, to: number, n: number): number[] {
  const out: number[] = [];
  const a = Math.round(from) % n, b = Math.round(to) % n;
  let i = a;
  for (let guard = 0; guard <= n; guard++) {
    out.push(i);
    if (i === b) break;
    i = (i + 1) % n;
  }
  return out;
}

/** Реальная траектория пилота = осевая линия + измеренное боковое смещение. */
export function lineXY(a: Analysis, lat: Float64Array, idxs: number[]): [number[], number[]] {
  const xs: number[] = [], ys: number[] = [];
  for (const i of idxs) {
    const [nx, ny] = normalAt(a, i);
    const off = lat[Math.min(i, lat.length - 1)] || 0;
    xs.push(a.track.x[i] + nx * off);
    ys.push(a.track.y[i] + ny * off);
  }
  return [xs, ys];
}

export function TrackMap({ a, mode, values, lines, cornerLabel, cursorS, height = 420, onHover }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const pts = useRef<Float64Array | null>(null);   // экранные координаты осевой, для наведения

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
    const pad = cornerLabel ? 46 : 34;
    const sc = Math.min((W - 2 * pad) / (maxX - minX), (H - 2 * pad) / (maxY - minY));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const px = (v: number) => W / 2 + (v - cx) * sc;
    const py = (v: number) => H / 2 - (v - cy) * sc;

    const screen = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) { screen[i * 2] = px(x[i]); screen[i * 2 + 1] = py(y[i]); }
    pts.current = screen;

    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < values.length; i++) {
      if (!isFinite(values[i])) continue;
      lo = Math.min(lo, values[i]); hi = Math.max(hi, values[i]);
    }
    const span = hi - lo || 1;
    const dScale = Math.max(Math.abs(lo), Math.abs(hi)) || 1;

    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const baseW = mode === 'lines' ? 13 : 10;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const vi = values[Math.min(i, values.length - 1)];
      ctx.strokeStyle = mode === 'lines' ? '#1e2430'
        : mode === 'delta' ? deltaColor(vi, dScale)
        : speedColor((vi - lo) / span);
      ctx.lineWidth = baseW;
      ctx.beginPath();
      ctx.moveTo(screen[i * 2], screen[i * 2 + 1]);
      ctx.lineTo(screen[j * 2], screen[j * 2 + 1]);
      ctx.stroke();
    }

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

    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let ci = 0; ci < a.corners.length; ci++) {
      const c = a.corners[ci];
      const i = Math.round(c.sApex) % n;
      const ax = screen[i * 2], ay = screen[i * 2 + 1];
      const dx = x[i] - cx, dy = y[i] - cy;
      const L = Math.hypot(dx, dy) || 1;
      const ox = ax + (dx / L) * 28, oy = ay - (dy / L) * 28;
      ctx.strokeStyle = '#39414f'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ox, oy); ctx.stroke();
      ctx.fillStyle = '#12161e';
      ctx.beginPath(); ctx.arc(ox, oy, 11, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#4d566a'; ctx.stroke();
      ctx.font = '600 11px ui-sans-serif, system-ui';
      ctx.fillStyle = '#cfd7e5';
      ctx.fillText(String(c.id), ox, oy + 0.5);

      const lbl = cornerLabel?.(ci);
      if (lbl) {
        ctx.font = '600 11px ui-sans-serif, system-ui';
        const w = ctx.measureText(lbl).width;
        // подпись не должна вылезать за холст — у краёв переносим на другую сторону
        let ly = oy + (dy > 0 ? -20 : 20);
        if (ly < 12) ly = oy + 20;
        if (ly > H - 12) ly = oy - 20;
        const lx = Math.max(w / 2 + 6, Math.min(W - w / 2 - 6, ox));
        ctx.fillStyle = 'rgba(10,12,16,0.88)';
        ctx.beginPath();
        ctx.roundRect(lx - w / 2 - 4, ly - 8, w + 8, 16, 4);
        ctx.fill();
        ctx.fillStyle = '#e7ecf5';
        ctx.fillText(lbl, lx, ly + 0.5);
      }
    }

    const [snx, sny] = normalAt(a, 0);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(px(x[0] + snx * 6), py(y[0] + sny * 6));
    ctx.lineTo(px(x[0] - snx * 6), py(y[0] - sny * 6));
    ctx.stroke();

    if (cursorS != null) {
      const i = Math.round(cursorS) % n;
      if (i >= 0 && isFinite(i)) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(screen[i * 2], screen[i * 2 + 1], 5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#0a0c10'; ctx.lineWidth = 2; ctx.stroke();
      }
    }
  }, [a, mode, values, lines, cornerLabel, cursorS, height]);

  const move = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onHover || !pts.current) return;
    const r = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const s = pts.current;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < s.length / 2; i++) {
      const d = (s[i * 2] - mx) ** 2 + (s[i * 2 + 1] - my) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    onHover(bd < 40 * 40 ? bi : null);
  };

  return (
    <div ref={box} style={{ width: '100%' }}>
      <canvas
        ref={ref}
        onMouseMove={move}
        onMouseLeave={() => onHover?.(null)}
        style={{ display: 'block', cursor: onHover ? 'crosshair' : 'default' }}
      />
    </div>
  );
}

/** Числовая шкала под картой — без неё цвета невозможно прочитать. */
export function MapLegend({ mode, min, max, unit }: {
  mode: MapMode; min: number; max: number; unit: string;
}) {
  if (mode === 'lines') return null;
  const gradient = mode === 'speed'
    ? `linear-gradient(90deg, ${SPEED_STOPS.map(([p, c]) => `rgb(${c.join(',')}) ${p * 100}%`).join(', ')})`
    : `linear-gradient(90deg, ${deltaColor(-1, 1)}, ${deltaColor(0, 1)}, ${deltaColor(1, 1)})`;

  const ticks = mode === 'speed'
    ? [0, 0.25, 0.5, 0.75, 1].map(f => ({ f, label: (min + (max - min) * f).toFixed(0) }))
    : [
      { f: 0, label: `−${max.toFixed(1)}` }, { f: 0.5, label: '0' },
      { f: 1, label: `+${max.toFixed(1)}` },
    ];

  return (
    <div className="mt-3">
      <div className="h-2 rounded-full" style={{ background: gradient }} />
      <div className="relative h-4 mt-1">
        {ticks.map((t, i) => (
          <span key={i} className="absolute text-[10px] text-[var(--muted)] num -translate-x-1/2"
            style={{ left: `${t.f * 100}%` }}>{t.label}</span>
        ))}
        <span className="absolute right-0 text-[10px] text-[var(--muted-2)]" style={{ top: 14 }}>{unit}</span>
      </div>
    </div>
  );
}
