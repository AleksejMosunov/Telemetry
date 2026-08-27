/**
 * Компактный формат сессии для хранения в облаке.
 *
 * Из 22 каналов AiM анализу нужны восемь. Значения кладём целыми с фиксированным
 * масштабом и кодируем разностями соседних отсчётов: координаты и время меняются
 * плавно, поэтому разности маленькие и хорошо жмутся. На реальных логах выходит
 * ~28x к исходному CSV (7.8 МБ -> 276 КБ после gzip).
 *
 * Сжатие здесь намеренно не делается: gzip навешивает слой хранения, а этот
 * модуль остаётся синхронным и одинаково работает в браузере и в Node.
 */
import type { Session } from './parse';

const MAGIC = 0x4b544c4d;   // "KTLM"
const VERSION = 1;

/** Каналы, без которых анализ не построить, и точность их хранения. */
export const PACKED_CHANNELS: Array<{ name: string; scale: number }> = [
  // 0.1 мс: времена кругов берутся из отсечек, здесь точность нужна только
  // для интерполяции внутри круга, но запас дешёвый
  { name: 'Time', scale: 10000 },
  { name: 'GPS Latitude', scale: 1e7 },    // ~1.1 см
  { name: 'GPS Longitude', scale: 1e7 },
  { name: 'GPS Speed', scale: 100 },       // 0.01 км/ч
  { name: 'YawRate', scale: 100 },         // 0.01 °/с
  { name: 'GPS LatAcc', scale: 1000 },     // 0.001 g
  { name: 'GPS LonAcc', scale: 1000 },
  // Вертикаль нужна для тряски. В заездах, сохранённых до её появления, канала
  // нет — заголовок перечисляет реальный состав, поэтому они читаются как прежде.
  { name: 'VerticalAcc', scale: 1000 },
];

interface Header {
  meta: Record<string, string>;
  beacons: number[];
  sampleRate: number;
  n: number;
  sourceName: string;
  /** какие каналы реально попали в файл — часть может отсутствовать в логе */
  channels: Array<{ name: string; unit: string; scale: number }>;
}

export function packSession(s: Session): Uint8Array {
  const present = PACKED_CHANNELS.filter(c => s.channels.includes(c.name));
  if (!present.some(c => c.name === 'GPS Latitude') || !present.some(c => c.name === 'GPS Longitude')) {
    throw new Error(`${s.sourceName}: без GPS Latitude и GPS Longitude сессию не сохранить`);
  }

  const header: Header = {
    meta: s.meta,
    beacons: s.beacons,
    sampleRate: s.sampleRate,
    n: s.n,
    sourceName: s.sourceName,
    channels: present.map(c => ({
      name: c.name,
      unit: s.units[s.channels.indexOf(c.name)] ?? '',
      scale: c.scale,
    })),
  };

  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const body = new Int32Array(s.n * present.length);
  present.forEach((c, k) => {
    const col = s.columns[s.channels.indexOf(c.name)];
    let prev = 0;
    for (let i = 0; i < s.n; i++) {
      const v = Math.round(col[i] * c.scale);
      body[k * s.n + i] = v - prev;
      prev = v;
    }
  });

  const out = new Uint8Array(14 + headerBytes.length + body.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC);
  dv.setUint16(4, VERSION);
  dv.setUint32(6, headerBytes.length);
  dv.setUint32(10, body.byteLength);
  out.set(headerBytes, 14);
  out.set(new Uint8Array(body.buffer, body.byteOffset, body.byteLength), 14 + headerBytes.length);
  return out;
}

export function unpackSession(bytes: Uint8Array): Session {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0) !== MAGIC) throw new Error('Не файл сессии: неверная сигнатура');
  const version = dv.getUint16(4);
  if (version !== VERSION) throw new Error(`Версия формата ${version} не поддерживается`);
  const headerLen = dv.getUint32(6);
  const bodyLen = dv.getUint32(10);

  const header: Header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(14, 14 + headerLen)),
  );
  const { n, channels } = header;
  if (bodyLen !== n * channels.length * 4) throw new Error('Файл сессии повреждён: не сходится длина');

  // Int32Array требует выравнивания по 4 байтам, а заголовок произвольной длины —
  // поэтому копируем тело в свой буфер, а не смотрим в чужой через subarray.
  const raw = bytes.slice(14 + headerLen, 14 + headerLen + bodyLen);
  const body = new Int32Array(raw.buffer, raw.byteOffset, n * channels.length);

  const columns = channels.map((c, k) => {
    const col = new Float64Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += body[k * n + i];
      col[i] = acc / c.scale;
    }
    return col;
  });

  return {
    meta: header.meta,
    beacons: header.beacons,
    sampleRate: header.sampleRate,
    channels: channels.map(c => c.name),
    units: channels.map(c => c.unit),
    columns,
    n,
    sourceName: header.sourceName,
  };
}
