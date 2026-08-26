/**
 * Подготовка заезда к отправке в хранилище.
 *
 * Разбор идёт в браузере ДО отправки: наверх уходит не восьмимегабайтный CSV,
 * а упакованные 276 КБ. На трассе, где интернет раздаётся с телефона, разница
 * ощутимая — а серверу пришлось бы сперва принять весь исходный файл.
 */
import { parseAimCsv, type Session } from '../core/parse';
import { analyzeSessions, type DriverStats } from '../core/pipeline';
import { packSession } from '../core/pack';
import { contentHash, sessionFingerprint } from '../core/identity';
import { type TrackSignature } from '../core/trackid';
import { gzip } from './gzip';

/** Сводка заезда, ~1 КБ. Живёт в базе: по ней работают списки заездов и
 *  тренды сезона, не поднимая тяжёлые файлы из хранилища. */
export interface SessionSummary {
  laps: Array<{ i: number; t: number; clean: boolean; path: number }>;
  /** [круг][зона] — время в зоне, только по кругам в расчёте */
  zones: number[][];
  zoneNames: string[];
  stats: DriverStats;
  trackLength: number;
  corners: number;
}

export interface PreparedSession {
  /** имя исходного файла — только для показа */
  fileName: string;
  meta: Record<string, string>;
  /** значение поля Racer из логгера: по нему ищется привязка к пилоту */
  racer: string;
  /** когда записан заезд, из метаданных логгера */
  recordedAt: Date | null;
  fingerprint: string;
  contentHash: string;
  signature: TrackSignature;
  summary: SessionSummary;
  /** упакованные и сжатые сэмплы — то, что уедет в bucket */
  blob: Uint8Array;
  /** размеры для показа пользователю */
  sizes: { csv: number; packed: number };
}

/** "Sunday, August 16, 2026" + "4:00 PM" -> Date, насколько это вообще возможно. */
function recordedAt(meta: Record<string, string>): Date | null {
  const d = meta['Date'], t = meta['Time'];
  if (!d) return null;
  const parsed = new Date(`${d} ${t ?? ''}`.trim());
  return isNaN(parsed.getTime()) ? null : parsed;
}

function summarize(s: Session): SessionSummary {
  // Разбираем в одиночку: осевая линия строится по этой сессии. На втором этапе
  // здесь будет замороженная осевая конфигурации, и сводка станет сравнимой
  // между заездами напрямую.
  const a = analyzeSessions([s]);
  const d = a.drivers[0];
  const r3 = (v: number) => +v.toFixed(3);
  return {
    laps: d.laps.map(l => ({ i: l.index, t: r3(l.time), clean: l.clean, path: +l.pathLength.toFixed(1) })),
    zones: d.zoneByLap.map(row => Array.from(row, r3)),
    zoneNames: a.zones.map(z => z.corner.name),
    stats: d.stats,
    trackLength: +a.track.length.toFixed(2),
    corners: a.corners.length,
  };
}

export async function prepareSession(fileName: string, text: string): Promise<PreparedSession> {
  const s = parseAimCsv(text, fileName);
  const packed = packSession(s);
  const [blob, hash] = await Promise.all([gzip(packed), contentHash(text)]);
  const a = analyzeSessions([s]);

  return {
    fileName,
    meta: s.meta,
    racer: s.meta['Racer'] ?? '',
    recordedAt: recordedAt(s.meta),
    fingerprint: sessionFingerprint(s),
    contentHash: hash,
    signature: a.signature,
    summary: summarize(s),
    blob,
    sizes: { csv: text.length, packed: blob.length },
  };
}
