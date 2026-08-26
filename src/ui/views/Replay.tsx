import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ViewCtx } from '../App';
import type { Analysis, DriverResult } from '../../core/pipeline';
import { normalAt } from '../TrackMap';
import { lapTime, num } from '../format';

/** Один «призрак» на карте: конкретный круг конкретного пилота. */
interface Runner {
  d: DriverResult;
  label: string;
  color: string;
  t: Float64Array;      // время от старта круга на каждом метре
  v: Float64Array;
  lat: Float64Array;
  total: number;        // время круга
}

/** Где находится карт в момент time — дробный номер метра. */
function sAtTime(t: Float64Array, time: number): number {
  const n = t.length;
  if (!(time > 0)) return 0;
  if (time >= t[n - 1]) return n - 1;
  let lo = 0, hi = n - 1;
  while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (t[m] <= time) lo = m; else hi = m; }
  const d = t[hi] - t[lo];
  return d > 1e-9 ? lo + (time - t[lo]) / d : lo;
}

/** Линейная выборка канала в дробной точке дистанции. */
function sample(arr: Float64Array, s: number): number {
  const i = Math.floor(s), f = s - i;
  if (i >= arr.length - 1) return arr[arr.length - 1];
  return arr[i] + (arr[i + 1] - arr[i]) * f;
}

const SPEEDS = [0.25, 0.5, 1, 2] as const;
const TRAIL = 30;   // длина хвоста за картом, м

export function Replay({ ctx }: { ctx: ViewCtx }) {
  const { a, ref, name, color, lapMode } = ctx;

  // Какой круг показывать за каждого пилота: по умолчанию тот же режим,
  // что и во всём приложении, но здесь можно выбрать и конкретный круг.
  const [pick, setPick] = useState<Record<string, string>>({});
  const choiceOf = (d: DriverResult) => pick[d.id] ?? lapMode;

  const runners = useMemo<Runner[]>(() => a.drivers.map(d => {
    const c = choiceOf(d);
    if (c === 'best') {
      return { d, label: 'лучший круг', color: color(d), t: d.bestT, v: d.bestV, lat: d.bestLat, total: d.bestT[d.bestT.length - 1] };
    }
    if (c === 'median') {
      return { d, label: 'усреднённый круг', color: color(d), t: d.medT, v: d.medV, lat: d.medLat, total: d.medT[d.medT.length - 1] };
    }
    const li = Number(c);
    const tr = d.traces.find(t => t.lapIndex === li) ?? d.traces[0];
    return { d, label: `круг #${tr.lapIndex}`, color: color(d), t: tr.t, v: tr.v, lat: tr.lat, total: tr.t[tr.t.length - 1] };
  }), [a, pick, lapMode, color]);

  const refRunner = runners.find(r => r.d.id === ref.id) ?? runners[0];
  const duration = Math.max(...runners.map(r => r.total));

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [now, setNow] = useState(0);
  const timeRef = useRef(0);
  const drawRef = useRef<((t: number) => void) | null>(null);

  const seek = useCallback((t: number) => {
    timeRef.current = Math.max(0, Math.min(duration, t));
    setNow(timeRef.current);
    drawRef.current?.(timeRef.current);
  }, [duration]);

  const toggle = useCallback(() => {
    setPlaying(p => {
      if (!p && timeRef.current >= duration - 1e-6) { timeRef.current = 0; setNow(0); }
      return !p;
    });
  }, [duration]);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now(), pushed = 0;
    let id = 0;
    const step = (ts: number) => {
      const dt = (ts - last) / 1000; last = ts;
      timeRef.current += dt * speed;
      if (timeRef.current >= duration) { timeRef.current = duration; setPlaying(false); }
      drawRef.current?.(timeRef.current);
      // Цифры обновляем реже кадров: читать их всё равно можно только глазами.
      if (ts - pushed > 70) { pushed = ts; setNow(timeRef.current); }
      id = requestAnimationFrame(step);
    };
    id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(id);
  }, [playing, speed, duration]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === 'Space') { e.preventDefault(); toggle(); }
      else if (e.code === 'ArrowLeft') { e.preventDefault(); seek(timeRef.current - (e.shiftKey ? 1 : 0.2)); }
      else if (e.code === 'ArrowRight') { e.preventDefault(); seek(timeRef.current + (e.shiftKey ? 1 : 0.2)); }
      else if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') { setPlaying(false); seek(0); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [toggle, seek]);

  // Живые числа на текущий момент времени.
  const live = useMemo(() => {
    const sRef = sAtTime(refRunner.t, Math.min(now, refRunner.total));
    return runners.map(r => {
      const s = sAtTime(r.t, Math.min(now, r.total));
      return {
        r, s,
        v: sample(r.v, s),
        gap: r.d.id === refRunner.d.id ? 0 : sample(r.t, sRef) - now,
        metres: r.d.id === refRunner.d.id ? 0 : sRef - s,
        done: now >= r.total,
      };
    });
  }, [runners, refRunner, now]);

  const cornerNow = useMemo(() => {
    const s = sAtTime(refRunner.t, Math.min(now, refRunner.total));
    return a.corners.find(c => s >= c.sStart && s <= c.sEnd) ?? null;
  }, [a, refRunner, now]);

  return (
    <div className="flex flex-col gap-3">
      <div className="panel px-4 py-2.5">
        <div className="text-[13px] font-medium">Призрачный повтор</div>
        <div className="text-[11px] text-[var(--muted)] leading-relaxed">
          Круги сведены к общему старту и едут одновременно — это построение, а не реальная гонка.
          Видно, где разрыв открывается и отыгрывается ли он дальше.
          <span className="text-[var(--muted-2)]"> Пробел — пуск и пауза, стрелки — шаг, R — в начало.</span>
        </div>
      </div>

      <div className="panel p-3 flex items-center gap-3 flex-wrap">
        <button onClick={toggle}
          className="w-9 h-9 rounded-lg border border-[var(--line)] bg-[var(--panel-2)]
            hover:bg-[#1d222d] transition flex items-center justify-center text-[13px]">
          {playing ? '❚❚' : '▶'}
        </button>
        <button onClick={() => { setPlaying(false); seek(0); }}
          title="В начало круга"
          className="w-9 h-9 rounded-lg border border-[var(--line)] hover:bg-[var(--panel-2)]
            transition flex items-center justify-center text-[13px] text-[var(--muted)]">↺</button>

        <div className="flex rounded-lg border border-[var(--line)] overflow-hidden text-[11px]">
          {SPEEDS.map(s => (
            <button key={s} onClick={() => setSpeed(s)}
              className={`px-2.5 py-1.5 num transition ${speed === s ? 'bg-[var(--panel-2)] text-[var(--text)]' : 'text-[var(--muted)] hover:text-[var(--text)]'}`}>
              {s}×
            </button>
          ))}
        </div>

        <input type="range" min={0} max={duration} step={0.01} value={now}
          onChange={e => { setPlaying(false); seek(Number(e.target.value)); }}
          className="flex-1 min-w-[200px] accent-[#e7ecf5]" />

        <span className="num text-[13px] tabular-nums w-[120px] text-right">
          {now.toFixed(2)} <span className="text-[var(--muted-2)]">/ {duration.toFixed(2)} с</span>
        </span>
        <span className="text-[11px] text-[var(--muted)] w-[64px]">
          {cornerNow ? cornerNow.name : `${Math.round(sAtTime(refRunner.t, Math.min(now, refRunner.total)))} м`}
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_320px] items-start">
        <div className="panel p-3">
          <Stage a={a} runners={runners} refId={refRunner.d.id} timeRef={timeRef} drawRef={drawRef} />
        </div>

        <div className="panel p-3 flex flex-col gap-2">
          <div className="text-[11px] text-[var(--muted)] mb-0.5">
            Разрыв считается к «{name(ref)}»: плюс — отстаёт
          </div>
          {live.map(({ r, v, gap, metres, done }) => (
            <div key={r.d.id} className="rounded-lg p-2.5"
              style={{ background: r.d.id === refRunner.d.id ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.02)' }}>
              <div className="flex items-center gap-2 mb-1">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: r.color }} />
                <span className="text-[12px] font-medium truncate">{name(r.d)}</span>
                {done && <span className="text-[10px] text-[var(--muted-2)] ml-auto">финиш</span>}
              </div>
              <div className="flex items-baseline gap-3 num">
                <span className="text-[18px] font-semibold w-[72px]">{num(v, 0)}<span className="text-[11px] text-[var(--muted)] font-normal"> км/ч</span></span>
                {r.d.id === refRunner.d.id ? (
                  <span className="text-[12px] text-[var(--muted-2)]">опорный</span>
                ) : (
                  <span className="text-[15px] font-semibold"
                    style={{ color: gap > 0.005 ? 'var(--bad)' : gap < -0.005 ? 'var(--good)' : 'var(--muted)' }}>
                    {gap >= 0 ? '+' : '−'}{Math.abs(gap).toFixed(2)} с
                    <span className="text-[11px] text-[var(--muted)] font-normal">
                      {' '}· {Math.abs(metres).toFixed(1)} м {metres >= 0 ? 'позади' : 'впереди'}
                    </span>
                  </span>
                )}
              </div>
              <select
                value={choiceOf(r.d)}
                onChange={e => { setPick(p => ({ ...p, [r.d.id]: e.target.value })); seek(0); setPlaying(false); }}
                className="mt-2 w-full bg-[var(--panel-2)] border border-[var(--line)] rounded px-2 py-1
                  text-[11px] num text-[var(--muted)] outline-none focus:border-[var(--muted-2)]">
                <option value="median">усреднённый круг · {lapTime(r.d.medT[r.d.medT.length - 1])}</option>
                <option value="best">лучший круг · {lapTime(r.d.stats.best)}</option>
                {r.d.traces.map(t => (
                  <option key={t.lapIndex} value={String(t.lapIndex)}>
                    круг #{t.lapIndex} · {lapTime(t.t[t.t.length - 1])}
                  </option>
                ))}
              </select>
            </div>
          ))}
          {runners.length === 1 && (
            <div className="text-[11px] text-[var(--muted-2)] leading-relaxed mt-1">
              Загружен один заезд — сравнивать не с чем. Выберите разные круги одного пилота,
              чтобы посмотреть свой лучший против обычного, или добавьте второй заезд.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Карта и полоса дельты. Статика рисуется один раз в offscreen, каждый кадр — только
 *  копия готовой картинки плюс карты и курсор. Иначе 60 кадров в секунду не вытянуть. */
function Stage({ a, runners, refId, timeRef, drawRef }: {
  a: Analysis;
  runners: Runner[];
  refId: string;
  timeRef: React.RefObject<number>;
  drawRef: React.RefObject<((t: number) => void) | null>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const mapCv = useRef<HTMLCanvasElement>(null);
  const stripCv = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const map = mapCv.current, strip = stripCv.current;
    if (!map || !strip || !w) return;
    const dpr = window.devicePixelRatio || 1;
    const H = 360, SH = 132;
    // Трасса вытянута по вертикали: на всю ширину колонки карту растягивать незачем,
    // масштаб всё равно упрётся в высоту, а по бокам останется пустота.
    const mw = Math.min(w, 680);
    map.width = mw * dpr; map.height = H * dpr;
    map.style.width = `${mw}px`; map.style.height = `${H}px`;
    strip.width = w * dpr; strip.height = SH * dpr;
    strip.style.width = `${w}px`; strip.style.height = `${SH}px`;
    const mc = map.getContext('2d')!, sc = strip.getContext('2d')!;
    mc.setTransform(dpr, 0, 0, dpr, 0, 0);
    sc.setTransform(dpr, 0, 0, dpr, 0, 0);

    const { x, y, n, length } = a.track;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, x[i]); maxX = Math.max(maxX, x[i]);
      minY = Math.min(minY, y[i]); maxY = Math.max(maxY, y[i]);
    }
    const pad = 40;
    const sc0 = Math.min((mw - 2 * pad) / (maxX - minX), (H - 2 * pad) / (maxY - minY));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const px = (v: number) => mw / 2 + (v - cx) * sc0;
    const py = (v: number) => H / 2 - (v - cy) * sc0;

    /** Экранная точка карта: осевая + его собственное боковое смещение. */
    const at = (lat: Float64Array, s: number): [number, number] => {
      const i = Math.max(0, Math.min(n - 1, Math.floor(s)));
      const j = Math.min(n - 1, i + 1);
      const f = s - i;
      const [nx0, ny0] = normalAt(a, i), [nx1, ny1] = normalAt(a, j);
      const o0 = lat[Math.min(i, lat.length - 1)] || 0, o1 = lat[Math.min(j, lat.length - 1)] || 0;
      const X0 = x[i] + nx0 * o0, Y0 = y[i] + ny0 * o0;
      const X1 = x[j] + nx1 * o1, Y1 = y[j] + ny1 * o1;
      return [px(X0 + (X1 - X0) * f), py(Y0 + (Y1 - Y0) * f)];
    };

    // --- статичная подложка карты ---
    const base = document.createElement('canvas');
    base.width = map.width; base.height = map.height;
    const bc = base.getContext('2d')!;
    bc.setTransform(dpr, 0, 0, dpr, 0, 0);
    bc.lineCap = 'round'; bc.lineJoin = 'round';
    bc.strokeStyle = '#1a1f2a'; bc.lineWidth = 20;
    bc.beginPath();
    for (let i = 0; i < n; i++) (i ? bc.lineTo(px(x[i]), py(y[i])) : bc.moveTo(px(x[i]), py(y[i])));
    bc.closePath(); bc.stroke();
    bc.strokeStyle = '#232937'; bc.lineWidth = 16; bc.stroke();

    bc.textAlign = 'center'; bc.textBaseline = 'middle';
    for (const c of a.corners) {
      const i = Math.round(c.sApex) % n;
      const ax = px(x[i]), ay = py(y[i]);
      const dx = x[i] - cx, dy = y[i] - cy, L = Math.hypot(dx, dy) || 1;
      const ox = ax + (dx / L) * 26, oy = ay - (dy / L) * 26;
      bc.fillStyle = '#12161e';
      bc.beginPath(); bc.arc(ox, oy, 10, 0, Math.PI * 2); bc.fill();
      bc.strokeStyle = '#39414f'; bc.lineWidth = 1; bc.stroke();
      bc.font = '600 10px ui-sans-serif, system-ui';
      bc.fillStyle = '#8791a4';
      bc.fillText(String(c.id), ox, oy + 0.5);
    }
    const [snx, sny] = normalAt(a, 0);
    bc.strokeStyle = '#ffffff'; bc.lineWidth = 2.5;
    bc.beginPath();
    bc.moveTo(px(x[0] + snx * 7), py(y[0] + sny * 7));
    bc.lineTo(px(x[0] - snx * 7), py(y[0] - sny * 7));
    bc.stroke();

    // --- статичная подложка полосы дельты ---
    const refRunner = runners.find(r => r.d.id === refId) ?? runners[0];
    const others = runners.filter(r => r.d.id !== refId);
    const padL = 46, padR = 12, padT = 12, padB = 18;
    const plotW = w - padL - padR, plotH = SH - padT - padB;
    // Диапазон несимметричный: если один пилот весь круг только теряет, симметричная
    // шкала оставила бы половину полосы пустой и вдвое сплющила бы саму кривую.
    let dLo = 0, dHi = 0;
    for (const r of others) for (let i = 0; i < r.t.length; i++) {
      const d = r.t[i] - refRunner.t[i];
      dLo = Math.min(dLo, d); dHi = Math.max(dHi, d);
    }
    dLo = Math.min(dLo * 1.15, -0.05); dHi = Math.max(dHi * 1.15, 0.05);
    const sx = (s: number) => padL + (s / (length || 1)) * plotW;
    const sy = (d: number) => padT + plotH - ((d - dLo) / (dHi - dLo)) * plotH;

    const sb = document.createElement('canvas');
    sb.width = strip.width; sb.height = strip.height;
    const sbc = sb.getContext('2d')!;
    sbc.setTransform(dpr, 0, 0, dpr, 0, 0);
    sbc.fillStyle = 'rgba(255,255,255,0.03)';
    for (const c of a.corners) sbc.fillRect(sx(c.sStart), padT, sx(c.sEnd) - sx(c.sStart), plotH);
    sbc.strokeStyle = '#2b3243'; sbc.lineWidth = 1;
    sbc.beginPath(); sbc.moveTo(padL, sy(0)); sbc.lineTo(padL + plotW, sy(0)); sbc.stroke();
    sbc.font = '10px ui-sans-serif, system-ui';
    sbc.fillStyle = '#5d6779'; sbc.textAlign = 'right'; sbc.textBaseline = 'middle';
    sbc.fillText(`+${dHi.toFixed(2)}`, padL - 6, padT + 5);
    sbc.fillText('0', padL - 6, sy(0));
    sbc.fillText(dLo.toFixed(2).replace('-', '−'), padL - 6, padT + plotH - 5);
    sbc.textAlign = 'center'; sbc.textBaseline = 'top';
    for (const c of a.corners) sbc.fillText(c.name, (sx(c.sStart) + sx(c.sEnd)) / 2, SH - padB + 3);
    for (const r of others) {
      sbc.strokeStyle = r.color; sbc.lineWidth = 1.8;
      sbc.beginPath();
      for (let i = 0; i < r.t.length; i++) {
        const X = sx(i), Y = sy(r.t[i] - refRunner.t[i]);
        i ? sbc.lineTo(X, Y) : sbc.moveTo(X, Y);
      }
      sbc.stroke();
    }

    const draw = (time: number) => {
      mc.clearRect(0, 0, mw, H);
      mc.drawImage(base, 0, 0, mw, H);
      mc.lineCap = 'round'; mc.lineJoin = 'round';

      const pos = runners.map(r => sAtTime(r.t, Math.min(time, r.total)));

      // Сначала все хвосты, потом все карты: иначе хвост догоняющего закрашивает
      // того, кто идёт впереди в паре метров, и его просто не найти на карте.
      runners.forEach((r, ri) => {
        for (let k = TRAIL; k > 0; k--) {
          const s1 = Math.max(0, pos[ri] - k), s0 = Math.max(0, pos[ri] - k + 1);
          if (s1 === s0) continue;
          const [X0, Y0] = at(r.lat, s1), [X1, Y1] = at(r.lat, s0);
          mc.strokeStyle = r.color;
          mc.globalAlpha = 0.5 * (1 - k / TRAIL);
          mc.lineWidth = 3.5;
          mc.beginPath(); mc.moveTo(X0, Y0); mc.lineTo(X1, Y1); mc.stroke();
        }
      });
      mc.globalAlpha = 1;
      runners.forEach((r, ri) => {
        const [X, Y] = at(r.lat, pos[ri]);
        mc.fillStyle = r.color;
        mc.beginPath(); mc.arc(X, Y, 6, 0, Math.PI * 2); mc.fill();
        mc.strokeStyle = '#0a0c10'; mc.lineWidth = 2; mc.stroke();
      });

      sc.clearRect(0, 0, w, SH);
      sc.drawImage(sb, 0, 0, w, SH);
      const sRef = sAtTime(refRunner.t, Math.min(time, refRunner.total));
      sc.strokeStyle = 'rgba(255,255,255,0.75)'; sc.lineWidth = 1;
      sc.beginPath(); sc.moveTo(sx(sRef), padT); sc.lineTo(sx(sRef), padT + plotH); sc.stroke();
      for (const r of others) {
        const d = sample(r.t, sRef) - sample(refRunner.t, sRef);
        sc.fillStyle = r.color;
        sc.beginPath(); sc.arc(sx(sRef), sy(d), 3.5, 0, Math.PI * 2); sc.fill();
      }
    };

    drawRef.current = draw;
    draw(timeRef.current);
    return () => { drawRef.current = null; };
  }, [a, runners, refId, w, drawRef, timeRef]);

  return (
    <div ref={box} style={{ width: '100%' }}>
      <canvas ref={mapCv} style={{ display: 'block', margin: '0 auto' }} />
      <div className="text-[10px] text-[var(--muted-2)] mt-1 mb-0.5">накопленный разрыв по дистанции круга, с</div>
      <canvas ref={stripCv} style={{ display: 'block' }} />
    </div>
  );
}
