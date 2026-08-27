-- Схема хранилища заездов. Выполняется в SQL-редакторе Supabase.
-- Доступ разграничивают политики RLS: экран входа лишь выдаёт токен,
-- а решает, что кому видно, сама база — обойти это из браузера нельзя.

-- ───────────────────────────── команды и люди ─────────────────────────────

create table teams (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table memberships (
  team_id uuid not null references teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role    text not null default 'driver' check (role in ('coach', 'driver')),
  primary key (team_id, user_id)
);

-- Пилот — сущность команды, а не аккаунт: у большинства пилотов входа в
-- приложение нет и не будет, их заезды грузит тренер.
create table drivers (
  id      uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  name    text not null,
  -- если у пилота есть аккаунт — он видит свои заезды сам
  user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (team_id, name)
);

-- Логгер пишет в лог поле Racer, и оно ненадёжно: в реальных логах команды там
-- стоит "Marafon" у обоих пилотов — это название карта, а не человек. Поэтому
-- алиас не правило, а подсказка: храним все связки, какие были.
--
-- Правило подстановки: если алиас до сих пор связывали ровно с одним пилотом —
-- подставляем его. Если с разными — подсказка себя дискредитировала, и при
-- загрузке спрашиваем всегда. Так справочник сам себя чинит.
create table driver_aliases (
  team_id   uuid not null references teams(id) on delete cascade,
  alias     text not null,
  driver_id uuid not null references drivers(id) on delete cascade,
  uses      int  not null default 1,
  primary key (team_id, alias, driver_id)
);

-- ───────────────────────────── трассы ─────────────────────────────

-- Площадка: опознаётся по координатам.
create table tracks (
  id      uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  name    text not null,
  lat     double precision not null,
  lon     double precision not null,
  created_at timestamptz not null default now()
);

-- Конфигурация: у одной площадки их бывает несколько, и опознаются они
-- по форме траектории, а не по названию.
create table track_configs (
  id        uuid primary key default gen_random_uuid(),
  track_id  uuid not null references tracks(id) on delete cascade,
  name      text not null,
  length_m  double precision not null,
  -- отпечаток формы: центр, длина и прореженная осевая линия
  signature jsonb not null,
  -- Границы секторов, заданные вручную: доли длины круга, например [0.33, 0.66].
  -- Хранятся долями, а не метрами: длина круга слегка гуляет от заезда к заезду,
  -- доля переживает это без сдвига границ. Пусто — сектора считаются автоматически.
  sectors   jsonb,
  -- замороженная осевая линия: пока пусто, заполняется на втором этапе.
  -- Ради неё всё и затевается: пока осевая пересчитывается при каждой
  -- загрузке, нумерация поворотов не может быть общей для всего сезона.
  centerline_path text,
  created_at timestamptz not null default now(),
  unique (track_id, name)
);

-- ───────────────────────────── заезды ─────────────────────────────

create table sessions (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid not null references teams(id) on delete cascade,
  driver_id  uuid references drivers(id) on delete set null,
  config_id  uuid references track_configs(id) on delete set null,
  recorded_at timestamptz,
  -- метаданные логгера как есть: Racer, Date, Time, Duration, Vehicle и прочее
  meta       jsonb not null default '{}',
  -- сводка ~1 КБ: времена кругов и зон. По ней работают списки и тренды
  -- сезона, не поднимая тяжёлые файлы из хранилища.
  summary    jsonb not null default '{}',
  -- путь к упакованным сэмплам в bucket "sessions" (~276 КБ на заезд)
  samples_path text not null,
  -- SHA-256 файла: ловит тот же файл под другим именем
  content_hash text not null,
  -- Racer|Date|Time|Duration|Vehicle: ловит ту же сессию, выгруженную
  -- повторно с другим набором каналов — байты другие, заезд тот же
  fingerprint  text,
  uploaded_by  uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

-- Два ключа дедупа. Имя файла ключом не годится: экспорт переименовывают,
-- и два разных заезда запросто называются одинаково.
create unique index sessions_hash_uniq on sessions (team_id, content_hash);
create unique index sessions_fingerprint_uniq on sessions (team_id, fingerprint)
  where fingerprint is not null and fingerprint <> '';

create index sessions_by_driver on sessions (team_id, driver_id, recorded_at desc);
create index sessions_by_config on sessions (team_id, config_id, recorded_at desc);

-- Снятые круги переезжают из localStorage в базу: они должны быть общими
-- для команды, а не жить в одном браузере у одного человека.
create table lap_exclusions (
  session_id uuid not null references sessions(id) on delete cascade,
  lap_index  int  not null,
  reason     text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (session_id, lap_index)
);

-- ───────────────────────────── доступ ─────────────────────────────

-- SECURITY DEFINER, иначе политика на memberships обращалась бы к memberships
-- и упёрлась бы в бесконечную рекурсию.
create or replace function is_team_member(t uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from memberships m where m.team_id = t and m.user_id = auth.uid());
$$;

create or replace function is_team_coach(t uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from memberships m
    where m.team_id = t and m.user_id = auth.uid() and m.role = 'coach'
  );
$$;

alter table teams           enable row level security;
alter table memberships     enable row level security;
alter table drivers         enable row level security;
alter table driver_aliases  enable row level security;
alter table tracks          enable row level security;
alter table track_configs   enable row level security;
alter table sessions        enable row level security;
alter table lap_exclusions  enable row level security;

create policy team_read on teams for select using (is_team_member(id));
create policy team_edit on teams for update using (is_team_coach(id));

create policy membership_read on memberships for select using (is_team_member(team_id));
create policy membership_write on memberships for all
  using (is_team_coach(team_id)) with check (is_team_coach(team_id));

-- Справочники команды видит вся команда, правит тренер.
create policy driver_read on drivers for select using (is_team_member(team_id));
create policy driver_write on drivers for all
  using (is_team_coach(team_id)) with check (is_team_coach(team_id));

create policy alias_read on driver_aliases for select using (is_team_member(team_id));
create policy alias_write on driver_aliases for all
  using (is_team_member(team_id)) with check (is_team_member(team_id));

create policy track_read on tracks for select using (is_team_member(team_id));
create policy track_write on tracks for all
  using (is_team_member(team_id)) with check (is_team_member(team_id));

create policy config_read on track_configs for select
  using (exists (select 1 from tracks t where t.id = track_id and is_team_member(t.team_id)));
create policy config_write on track_configs for all
  using (exists (select 1 from tracks t where t.id = track_id and is_team_member(t.team_id)))
  with check (exists (select 1 from tracks t where t.id = track_id and is_team_member(t.team_id)));

-- Тренер видит все заезды команды, пилот — только свои.
create policy session_read on sessions for select using (
  is_team_coach(team_id)
  or exists (select 1 from drivers d where d.id = driver_id and d.user_id = auth.uid())
);
create policy session_write on sessions for all
  using (is_team_coach(team_id)) with check (is_team_coach(team_id));

create policy exclusion_read on lap_exclusions for select
  using (exists (select 1 from sessions s where s.id = session_id and is_team_member(s.team_id)));
create policy exclusion_write on lap_exclusions for all
  using (exists (select 1 from sessions s where s.id = session_id and is_team_coach(s.team_id)))
  with check (exists (select 1 from sessions s where s.id = session_id and is_team_coach(s.team_id)));

-- ───────────────────────────── файлы ─────────────────────────────

insert into storage.buckets (id, name, public) values ('sessions', 'sessions', false)
  on conflict (id) do nothing;

-- Путь в bucket: {team_id}/{session_id}.bin.gz — первая часть пути и есть
-- команда, по ней и проверяем доступ.
create policy sessions_bucket_read on storage.objects for select
  using (bucket_id = 'sessions' and is_team_member(((storage.foldername(name))[1])::uuid));
create policy sessions_bucket_write on storage.objects for insert
  with check (bucket_id = 'sessions' and is_team_coach(((storage.foldername(name))[1])::uuid));
create policy sessions_bucket_delete on storage.objects for delete
  using (bucket_id = 'sessions' and is_team_coach(((storage.foldername(name))[1])::uuid));

-- ───────────────────────────── первый вход ─────────────────────────────

-- Создаёт команду и делает вызвавшего тренером. Нужна ровно один раз.
create or replace function bootstrap_team(team_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  if auth.uid() is null then raise exception 'нужен вход'; end if;
  insert into teams (name) values (team_name) returning id into t;
  insert into memberships (team_id, user_id, role) values (t, auth.uid(), 'coach');
  return t;
end;
$$;


-- ── миграция для уже развёрнутой базы ──────────────────────────────────────
-- alter table track_configs add column if not exists sectors jsonb;
