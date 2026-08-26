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

  const refresh = useCallback(async () => {
    if (!cloudEnabled) return;
    setBusy(true);
    try {
      const user = await currentUser();
      setEmail(user?.email ?? null);
      if (!user) { setTeam(null); setDrivers([]); setConfigs([]); setSessions([]); return; }
      const teams = await myTeams();
      const t = teams[0] ?? null;
      setTeam(t);
      if (!t) { setDrivers([]); setConfigs([]); setSessions([]); return; }
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
  }, []);

  useEffect(() => {
    if (!cloudEnabled) return;
    refresh();
    return onAuthChange(() => { refresh(); });
  }, [refresh]);

  return {
    enabled: cloudEnabled, ready, signedIn: Boolean(email), email,
    team, drivers, configs, sessions, busy, error, setError, refresh,
  };
}
