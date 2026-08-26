export const lapTime = (s: number) => {
  if (!isFinite(s)) return '—';
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m > 0 ? `${m}:${r.toFixed(3).padStart(6, '0')}` : r.toFixed(3);
};

export const delta = (d: number, digits = 3) =>
  !isFinite(d) ? '—' : `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d).toFixed(digits)}`;

export const num = (v: number, digits = 1) => (isFinite(v) ? v.toFixed(digits) : '—');

/** Цвет дельты: быстрее опорного — зелёный, медленнее — красный. */
export const deltaColor = (d: number) =>
  Math.abs(d) < 0.005 ? 'var(--muted)' : d > 0 ? 'var(--bad)' : 'var(--good)';

/** Русское склонение по числу: «1 круг», «2 круга», «5 кругов». */
export function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
}
