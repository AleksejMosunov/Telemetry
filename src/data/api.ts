/**
 * Работа с облаком. Ходим в базу напрямую из браузера — прослойного API нет
 * и не нужно: что кому видно, решают политики RLS внутри Postgres.
 */
import { supabase } from './client';
import { gunzip } from './gzip';
import type { TrackSignature } from '../core/trackid';
import type { PreparedSession, SessionSummary } from './upload';

export interface Team { id: string; name: string; role: 'coach' | 'driver' }
export interface Driver { id: string; name: string }

export interface TrackConfigRow {
  id: string; name: string;
  trackId: string; trackName: string;
  length: number;
  signature: TrackSignature;
  /** ручные границы секторов в долях круга; null — считать автоматически */
  sectors: number[] | null;
}

export interface SessionRow {
  id: string;
  driverId: string | null; driverName: string | null;
  configId: string | null; configName: string | null; trackName: string | null;
  recordedAt: string | null;
  meta: Record<string, string>;
  summary: SessionSummary;
  samplesPath: string;
  fingerprint: string | null;
}

const fail = (what: string, e: { message: string } | null) => {
  if (e) throw new Error(`${what}: ${e.message}`);
};

// ───────────────────────────── вход ─────────────────────────────

/** Текущий пользователь из сохранённой сессии. Берём getSession, а не getUser:
 *  первый читает локально, второй ходит на сервер за проверкой токена. */
export async function currentUser() {
  const { data } = await supabase().auth.getSession();
  return data.session?.user ?? null;
}

/**
 * Подписка на вход и выход.
 *
 * Колбэк получает почту готовой и НЕ должен сам обращаться к Supabase: внутри
 * обработчика клиент держит внутреннюю блокировку, и любой его вызов оттуда
 * повисает — вход застывал на «Минуту…», пока страницу не перезагрузишь.
 * Поэтому выходим из обработчика немедленно, а работу откладываем на макрозадачу.
 */
export function onAuthChange(cb: (email: string | null) => void) {
  const { data } = supabase().auth.onAuthStateChange((_event, session) => {
    const email = session?.user.email ?? null;
    setTimeout(() => cb(email), 0);
  });
  return () => data.subscription.unsubscribe();
}

export async function signIn(email: string, password: string) {
  const { error } = await supabase().auth.signInWithPassword({ email, password });
  fail('Не удалось войти', error);
}

export async function signUp(email: string, password: string) {
  const { data, error } = await supabase().auth.signUp({ email, password });
  fail('Не удалось создать аккаунт', error);
  // Если в Supabase включено подтверждение почты, сессии сразу не будет.
  return { needsConfirmation: !data.session };
}

export const signOut = () => supabase().auth.signOut();

// ───────────────────────────── команда ─────────────────────────────

export async function myTeams(): Promise<Team[]> {
  const { data, error } = await supabase()
    .from('memberships')
    .select('role, teams(id, name)');
  fail('Не удалось получить команды', error);
  return (data ?? []).map((r) => {
    const t = r.teams as unknown as { id: string; name: string };
    return { id: t.id, name: t.name, role: r.role as Team['role'] };
  });
}

export async function bootstrapTeam(name: string): Promise<string> {
  const { data, error } = await supabase().rpc('bootstrap_team', { team_name: name });
  fail('Не удалось создать команду', error);
  return data as string;
}

// ───────────────────────────── пилоты ─────────────────────────────

export async function listDrivers(teamId: string): Promise<Driver[]> {
  const { data, error } = await supabase()
    .from('drivers').select('id, name').eq('team_id', teamId).order('name');
  fail('Не удалось получить список пилотов', error);
  return data ?? [];
}

export async function createDriver(teamId: string, name: string): Promise<Driver> {
  const { data, error } = await supabase()
    .from('drivers').insert({ team_id: teamId, name }).select('id, name').single();
  fail('Не удалось добавить пилота', error);
  return data as Driver;
}

export async function renameDriver(id: string, name: string) {
  const { error } = await supabase().from('drivers').update({ name }).eq('id', id);
  fail('Не удалось переименовать пилота', error);
}

/** Удаление пилота. Заезды при этом не пропадают — они остаются в библиотеке
 *  без пилота, и их можно переназначить. Так задано внешним ключом в схеме. */
export async function deleteDriver(id: string) {
  const { error } = await supabase().from('drivers').delete().eq('id', id);
  fail('Не удалось удалить пилота', error);
}

/** Переназначить заезд другому пилоту — в том числе снятому. */
export async function reassignSession(sessionId: string, driverId: string | null) {
  const { error } = await supabase().from('sessions').update({ driver_id: driverId }).eq('id', sessionId);
  fail('Не удалось сменить пилота заезда', error);
}

/**
 * С кем раньше связывали это значение поля Racer.
 *
 * Подставлять пилота по такой памяти нельзя: в реальных логах Racer бывает
 * названием карта — «Marafon» стоит у всех пилотов команды. Память с одной
 * записью тогда не подсказка, а готовая ошибка, которую легко не заметить.
 * Поэтому возвращаем список и показываем его как предположение, а выбор
 * оставляем человеку.
 */
export async function aliasHistory(teamId: string, alias: string): Promise<string[]> {
  if (!alias) return [];
  const { data, error } = await supabase()
    .from('driver_aliases').select('driver_id').eq('team_id', teamId).eq('alias', alias);
  fail('Не удалось прочитать привязки', error);
  return (data ?? []).map(r => r.driver_id as string);
}

async function rememberAlias(teamId: string, alias: string, driverId: string) {
  if (!alias) return;
  // Связку запоминаем, но не затираем прежнюю: если алиас связывали с разными
  // пилотами, подсказка должна замолчать, а не выбрать последнего.
  await supabase().from('driver_aliases')
    .upsert({ team_id: teamId, alias, driver_id: driverId }, { onConflict: 'team_id,alias,driver_id', ignoreDuplicates: true });
}

// ───────────────────────────── трассы ─────────────────────────────

export async function listConfigs(teamId: string): Promise<TrackConfigRow[]> {
  type Res = { data: Array<Record<string, unknown>> | null; error: { code?: string; message: string } | null };
  const ask = (cols: string) => supabase()
    .from('track_configs').select(cols).eq('tracks.team_id', teamId) as unknown as Promise<Res>;

  let res = await ask('id, name, length_m, signature, sectors, tracks!inner(id, name, team_id)');
  // Колонка sectors появилась позже схемы: пока миграция не применена, работаем
  // без неё, а не роняем всю библиотеку.
  if (res.error?.code === '42703') {
    res = await ask('id, name, length_m, signature, tracks!inner(id, name, team_id)');
  }
  const { data, error } = res;
  fail('Не удалось получить список трасс', error);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const t = r.tracks as unknown as { id: string; name: string };
    return {
      id: r.id as string,
      name: r.name as string,
      trackId: t.id,
      trackName: t.name,
      length: r.length_m as number,
      signature: r.signature as TrackSignature,
      sectors: (r.sectors as number[] | null) ?? null,
    };
  });
}

/** Границы секторов трассы: их задаёт человек, и дальше они общие для команды. */
export async function saveConfigSectors(id: string, cuts: number[] | null) {
  const { error } = await supabase().from('track_configs')
    .update({ sectors: cuts }).eq('id', id);
  fail('Не удалось сохранить сектора', error);
}

/** Новая конфигурация: либо на существующей площадке, либо на новой. */
export async function createConfig(
  teamId: string, sig: TrackSignature,
  opts: { trackId?: string; trackName?: string; configName: string },
): Promise<TrackConfigRow> {
  let trackId = opts.trackId;
  let trackName = opts.trackName ?? '';
  if (!trackId) {
    const { data, error } = await supabase().from('tracks')
      .insert({ team_id: teamId, name: opts.trackName, lat: sig.lat, lon: sig.lon })
      .select('id, name').single();
    fail('Не удалось создать трассу', error);
    trackId = data!.id as string;
    trackName = data!.name as string;
  }
  const { data, error } = await supabase().from('track_configs')
    .insert({ track_id: trackId, name: opts.configName, length_m: sig.length, signature: sig })
    .select('id, name, length_m').single();
  fail('Не удалось создать конфигурацию', error);
  return {
    id: data!.id as string, name: data!.name as string,
    trackId, trackName, length: data!.length_m as number, signature: sig,
    sectors: null,
  };
}

export async function renameConfig(id: string, name: string) {
  const { error } = await supabase().from('track_configs').update({ name }).eq('id', id);
  fail('Не удалось переименовать конфигурацию', error);
}

/** Удаление конфигурации трассы. Разрешаем только пустую: иначе заезды
 *  остались бы без привязки, а восстановить её потом нечем. */
export async function deleteConfig(id: string) {
  const { count, error: cErr } = await supabase()
    .from('sessions').select('id', { count: 'exact', head: true }).eq('config_id', id);
  fail('Не удалось проверить конфигурацию', cErr);
  if (count) throw new Error(`В этой конфигурации ${count} заездов — сначала удалите их`);
  const { error } = await supabase().from('track_configs').delete().eq('id', id);
  fail('Не удалось удалить конфигурацию', error);
}

// ───────────────────────────── заезды ─────────────────────────────

const SESSION_COLS =
  'id, driver_id, config_id, recorded_at, meta, summary, samples_path, fingerprint,'
  + ' drivers(name), track_configs(name, tracks(name))';

/** Строка как её отдаёт Postgres. Своих типов базы не генерируем, поэтому
 *  описываем форму выборки здесь — один раз на оба запроса. */
interface RawSession {
  id: string;
  driver_id: string | null;
  config_id: string | null;
  recorded_at: string | null;
  meta: Record<string, string> | null;
  summary: SessionSummary;
  samples_path: string;
  fingerprint: string | null;
  drivers: { name: string } | null;
  track_configs: { name: string; tracks: { name: string } | null } | null;
}

const toSessionRow = (r: RawSession): SessionRow => ({
  id: r.id,
  driverId: r.driver_id,
  driverName: r.drivers?.name ?? null,
  configId: r.config_id,
  configName: r.track_configs?.name ?? null,
  trackName: r.track_configs?.tracks?.name ?? null,
  recordedAt: r.recorded_at,
  meta: r.meta ?? {},
  summary: r.summary,
  samplesPath: r.samples_path,
  fingerprint: r.fingerprint,
});

export async function listSessions(teamId: string): Promise<SessionRow[]> {
  const { data, error } = await supabase()
    .from('sessions').select(SESSION_COLS).eq('team_id', teamId)
    .order('recorded_at', { ascending: false, nullsFirst: false });
  fail('Не удалось получить список заездов', error);
  return ((data ?? []) as unknown as RawSession[]).map(toSessionRow);
}

/**
 * Уже загружен ли такой заезд: по содержимому файла или по отпечатку сессии.
 *
 * Два отдельных запроса, а не один через .or(): отпечаток содержит дату вида
 * "Sunday, August 16, 2026", а PostgREST режет выражение фильтра по запятым
 * и на таком значении спотыкается.
 */
export async function findDuplicate(
  teamId: string, contentHash: string, fingerprint: string,
): Promise<SessionRow | null> {
  const lookup = async (column: string, value: string) => {
    const { data, error } = await supabase()
      .from('sessions').select(SESSION_COLS)
      .eq('team_id', teamId).eq(column, value).limit(1);
    fail('Не удалось проверить на повтор', error);
    const rows = (data ?? []) as unknown as RawSession[];
    return rows.length ? toSessionRow(rows[0]) : null;
  };
  return (await lookup('content_hash', contentHash))
    ?? (fingerprint ? await lookup('fingerprint', fingerprint) : null);
}

/** Заливка заезда. Строку пишем первой: уникальный индекс отсечёт повтор
 *  раньше, чем в сеть уйдут сотни килобайт. */
export async function commitSession(
  teamId: string, p: PreparedSession,
  binding: { driverId: string; configId: string },
): Promise<string> {
  const id = crypto.randomUUID();
  const path = `${teamId}/${id}.bin.gz`;

  const { error: insErr } = await supabase().from('sessions').insert({
    id, team_id: teamId,
    driver_id: binding.driverId, config_id: binding.configId,
    recorded_at: p.recordedAt?.toISOString() ?? null,
    meta: p.meta, summary: p.summary,
    samples_path: path,
    content_hash: p.contentHash,
    fingerprint: p.fingerprint || null,
    uploaded_by: (await currentUser())?.id ?? null,
  });
  if (insErr) {
    throw new Error(insErr.code === '23505'
      ? 'Этот заезд уже загружен'
      : `Не удалось сохранить заезд: ${insErr.message}`);
  }

  const { error: upErr } = await supabase().storage.from('sessions')
    .upload(path, new Blob([p.blob as BlobPart], { type: 'application/gzip' }), {
      contentType: 'application/gzip', upsert: true,
    });
  if (upErr) {
    // строка без файла бесполезна и мешает повторной попытке
    await supabase().from('sessions').delete().eq('id', id);
    throw new Error(`Не удалось отправить файл: ${upErr.message}`);
  }

  await rememberAlias(teamId, p.racer, binding.driverId);
  return id;
}

/** Заезд из хранилища: распакованные байты компактного формата.
 *  Разбор дальше идёт в воркере — тем же путём, что и файл с диска. */
export async function downloadSamples(row: SessionRow): Promise<Uint8Array> {
  const { data, error } = await supabase().storage.from('sessions').download(row.samplesPath);
  fail('Не удалось получить файл заезда', error);
  return gunzip(new Uint8Array(await data!.arrayBuffer()));
}

export async function deleteSession(row: SessionRow) {
  await supabase().storage.from('sessions').remove([row.samplesPath]);
  const { error } = await supabase().from('sessions').delete().eq('id', row.id);
  fail('Не удалось удалить заезд', error);
}

// ───────────────────────────── снятые круги ─────────────────────────────

export async function listExclusions(sessionIds: string[]): Promise<Record<string, number[]>> {
  if (!sessionIds.length) return {};
  const { data, error } = await supabase()
    .from('lap_exclusions').select('session_id, lap_index').in('session_id', sessionIds);
  fail('Не удалось получить снятые круги', error);
  const out: Record<string, number[]> = {};
  for (const r of data ?? []) {
    (out[r.session_id as string] ??= []).push(r.lap_index as number);
  }
  return out;
}

export async function setExclusions(sessionId: string, laps: number[]) {
  const del = await supabase().from('lap_exclusions').delete().eq('session_id', sessionId);
  fail('Не удалось обновить снятые круги', del.error);
  if (!laps.length) return;
  const { error } = await supabase().from('lap_exclusions')
    .insert(laps.map(lap_index => ({ session_id: sessionId, lap_index })));
  fail('Не удалось сохранить снятые круги', error);
}
