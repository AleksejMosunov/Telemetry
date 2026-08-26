/**
 * Подключение к Supabase.
 *
 * Ключ здесь публичный по устройству: он и должен лежать в браузерном бандле.
 * Доступ к данным разграничивают политики RLS внутри базы, а не секретность
 * ключа. Сервисный ключ, который RLS обходит, во фронтенде не появляется
 * никогда — ему место только в серверных функциях.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** Настроено ли облако. Без него приложение работает как раньше — с файлами. */
export const cloudEnabled = Boolean(url && anonKey);

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!client) {
    if (!url || !anonKey) {
      throw new Error(
        'Облако не настроено: задайте VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY в .env.local',
      );
    }
    client = createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }
  return client;
}
