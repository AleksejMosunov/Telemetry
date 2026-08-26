import { useCallback, useEffect, useState } from 'react';
import { cloudEnabled } from '../../data/client';
import {
  currentUser, onAuthChange, myTeams, listDrivers, listConfigs, listSessions,
  type Team, type Driver, type TrackConfigRow, type SessionRow,
} from '../../data/api';

export interface CloudState {
  enabled: boolean;
  /** проверили сохранённую сессию — до этого момента ничего не показываем */
  ready: boolean;
  signedIn: boolean;
  email: string | null;
  team: Team | null;
  drivers: Driver[];
  configs: TrackConfigRow[];
  sessions: SessionRow[];
  busy: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
}

export function useCloud(): CloudState {
  const [ready, setReady] = useState(!cloudEnabled);
  const [email, setEmail] = useState<string | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [configs, setConfigs] = useState<TrackConfigRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clear = useCallback(() => {
    setTeam(null); setDrivers([]); setConfigs([]); setSessions([]);
  }, []);

  /** Загрузка справочников под уже известного пользователя. */
  const load = useCallback(async (mail: string | null) => {
    setEmail(mail);
    if (!mail) { clear(); setReady(true); return; }
    setBusy(true);
    try {
      const teams = await myTeams();
      const t = teams[0] ?? null;
      setTeam(t);
      if (!t) { clear(); return; }
      const [d, c, s] = await Promise.all([
        listDrivers(t.id), listConfigs(t.id), listSessions(t.id),
      ]);
      setDrivers(d); setConfigs(c); setSessions(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false); setReady(true);
    }
  }, [clear]);

  const refresh = useCallback(async () => {
    if (!cloudEnabled) return;
    load((await currentUser())?.email ?? null);
  }, [load]);

  useEffect(() => {
    if (!cloudEnabled) return;
    refresh();
    // Почта приходит из события — обращаться к Supabase за ней нельзя,
    // подробности в onAuthChange.
    return onAuthChange(mail => { load(mail); });
  }, [refresh, load]);

  return {
    enabled: cloudEnabled, ready, signedIn: Boolean(email), email,
    team, drivers, configs, sessions, busy, error, setError, refresh,
  };
}
