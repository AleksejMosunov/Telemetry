/**
 * Парсер AiM CSV (RaceStudio 3 export).
 * Формат: блок метаданных key,value..., пустая строка, строка каналов,
 * строка единиц, пустая строка, дальше данные.
 */

export interface Session {
  meta: Record<string, string>;
  /** Отсечки кругов от начала записи, сек */
  beacons: number[];
  sampleRate: number;
  channels: string[];
  units: string[];
  /** columns[i] — колонка канала channels[i] */
  columns: Float64Array[];
  n: number;
  sourceName: string;
  /** Имя пилота, пришедшее извне (привязка в библиотеке). Сильнее метаданных CSV. */
  displayName?: string;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      out.push(cur); cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export function parseAimCsv(text: string, sourceName: string): Session {
  const lines = text.split(/\r?\n/);

  const meta: Record<string, string> = {};
  let beacons: number[] = [];
  let headerIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const f = splitCsvLine(raw);
    // строка каналов — первая, где первое поле "Time", а второе не число
    if (f[0] === 'Time' && f.length > 3 && isNaN(Number(f[1]))) { headerIdx = i; break; }
    if (f[0] === 'Beacon Markers') beacons = f.slice(1).filter(s => s !== '').map(Number);
    else if (f.length >= 2) meta[f[0]] = f[1];
  }
  if (headerIdx < 0) throw new Error(`${sourceName}: не найдена строка каналов`);

  const channels = splitCsvLine(lines[headerIdx]);
  const units = splitCsvLine(lines[headerIdx + 1]);

  // первая строка данных
  let dataStart = headerIdx + 2;
  while (dataStart < lines.length &&
         (!lines[dataStart].trim() || isNaN(Number(splitCsvLine(lines[dataStart])[0])))) dataStart++;

  const rows: string[] = [];
  for (let i = dataStart; i < lines.length; i++) {
    if (lines[i].trim()) rows.push(lines[i]);
  }

  const nCh = channels.length;
  const n = rows.length;
  const columns = Array.from({ length: nCh }, () => new Float64Array(n));
  for (let r = 0; r < n; r++) {
    const f = splitCsvLine(rows[r]);
    for (let c = 0; c < nCh; c++) columns[c][r] = Number(f[c]);
  }

  return {
    meta, beacons,
    sampleRate: Number(meta['Sample Rate']) || 20,
    channels, units, columns, n, sourceName,
  };
}

export function ch(s: Session, name: string): Float64Array {
  const i = s.channels.indexOf(name);
  if (i < 0) throw new Error(`${s.sourceName}: нет канала "${name}"`);
  return s.columns[i];
}
