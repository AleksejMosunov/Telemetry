import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const env: Record<string, string> = {};
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1]] = m[2].trim();
}
const url = env.VITE_SUPABASE_URL, key = env.VITE_SUPABASE_ANON_KEY;
// ключ не печатаем — только форму, чтобы поймать типичные промахи
console.log('URL:', url || '(пусто)');
console.log('Ключ:', key ? `${key.slice(0, 14)}… длина ${key.length}` : '(ПУСТО)');
if (!url || !key) { console.log('\nНе заполнено — дальше идти некуда'); process.exit(1); }
if (url.includes('/rest/')) console.log('  ⚠ в URL лишний хвост /rest/v1 — нужен только базовый адрес');
if (/service_role|sb_secret/.test(key)) { console.log('  ✗ это секретный ключ, он обходит RLS — нужен publishable/anon'); process.exit(1); }

const db = createClient(url, key);
const TABLES = ['teams', 'memberships', 'drivers', 'driver_aliases', 'tracks',
  'track_configs', 'sessions', 'lap_exclusions'];

async function main() {
  console.log('\nТАБЛИЦЫ');
  let bad = 0;
  for (const t of TABLES) {
    const { error } = await db.from(t).select('*').limit(1);
    // RLS без входа отдаёт пустоту, но не ошибку. Ошибка = таблицы нет.
    const ok = !error;
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${t}${error ? '  (' + error.message + ')' : ''}`);
  }

  console.log('\nХРАНИЛИЩЕ');
  const { data: buckets, error: bErr } = await db.storage.listBuckets();
  if (bErr) console.log('  ? список корзин недоступен без входа — это нормально');
  else console.log('  корзины:', buckets.map(b => b.name).join(', ') || '(пусто)');

  console.log('\nВХОД');
  const { error: aErr } = await db.auth.getSession();
  console.log(aErr ? `  ✗ ${aErr.message}` : '  ✓ сервис авторизации отвечает');

  console.log(bad === 0
    ? '\nВСЁ НА МЕСТЕ — схема применена, подключение работает'
    : `\nНЕ НАЙДЕНО ТАБЛИЦ: ${bad} — похоже, схема не выполнилась целиком`);
}
main();
