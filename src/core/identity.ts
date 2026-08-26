/** Опознание сессии: чем считать, что этот заезд у нас уже есть. */
import type { Session } from './parse';

/**
 * Отпечаток заезда по метаданным логгера. Не зависит ни от имени файла, ни от
 * набора выгруженных каналов — поэтому ловит случай, когда ту же сессию
 * выгрузили из RaceStudio повторно с другими галочками.
 */
export function sessionFingerprint(s: Session): string {
  return [s.meta['Racer'], s.meta['Date'], s.meta['Time'], s.meta['Duration'], s.meta['Vehicle']]
    .filter(Boolean).join('|');
}

/**
 * SHA-256 содержимого файла. Ловит тот же файл, залитый под другим именем —
 * а имя файла как ключ не годится: экспорт легко переименовывают, и два разных
 * заезда запросто называются одинаково.
 */
export async function contentHash(data: Uint8Array | ArrayBuffer | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data)
    : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const buf = new Uint8Array(bytes).buffer;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
