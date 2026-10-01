import { useCallback, useEffect, useState } from 'react';
import { AppState, RefreshControl, ScrollView, Text, View } from 'react-native';
import { type LiveTripView } from '@safedrive/core';
import { Banner, Card, SEVERITY_COLORS, styles } from '../components/ui';
import { call } from '../lib/api';
import { s, tc } from '../lib/i18n';
import { type FamilyRef } from '../lib/session';

interface Notification {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
}

/** Simple parent view (the full dashboard is the web app). */
export function ParentScreen({ family }: { family: FamilyRef }) {
  const [live, setLive] = useState<LiveTripView[]>([]);
  const [notes, setNotes] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (manual = false) => {
      if (manual) setLoading(true);
      try {
        const [l, n] = await Promise.all([
          call<LiveTripView[]>(`/families/${family.id}/live`),
          call<{ items: Notification[] }>('/notifications?limit=20'),
        ]);
        setLive(l);
        setNotes(n.items);
      } catch {
        // offline
      } finally {
        setLoading(false);
      }
    },
    [family.id],
  );

  useEffect(() => {
    void load();
    // Poll only while the app is in the foreground (battery, data).
    const t = setInterval(() => {
      if (AppState.currentState === 'active') void load();
    }, 5_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.pad}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load(true)} />}
    >
      <Text style={styles.h1}>{family.name}</Text>
      <Text style={styles.h2}>{s('liveTrips')}</Text>
      {live.length === 0 && <Text style={styles.muted}>{s('noLiveTrips')}</Text>}
      {live.map((v) => (
        <Card key={v.tripId} style={{ borderColor: SEVERITY_COLORS[v.severity], borderWidth: 2 }}>
          {v.isDemo && <Banner text={s('demoBadge')} color="#7c3aed" />}
          <View style={styles.between}>
            <Text style={styles.h2}>{v.driverName}</Text>
            <Text style={{ color: SEVERITY_COLORS[v.severity], fontWeight: '800' }}>
              {tc(`severity.${v.severity}`)}
            </Text>
          </View>
          <Text style={styles.p}>
            {v.speedKmh !== null ? Math.round(v.speedKmh) : '--'} / {v.limitKmh ?? '—'}{' '}
            {tc('unit.kmh')} · {s('score')} {v.score}
          </Text>
          <Text style={styles.muted}>{v.connection}</Text>
        </Card>
      ))}
      <Text style={styles.h2}>{s('notifications')}</Text>
      {notes.map((n) => (
        <Card key={n.id}>
          <Text style={[styles.p, { fontWeight: n.readAt ? '400' : '700' }]}>{n.title}</Text>
          {n.body ? <Text style={styles.muted}>{n.body}</Text> : null}
          <Text style={styles.muted}>
            {new Date(n.createdAt).toLocaleString('he-IL', { timeZone: family.timezone })}
          </Text>
        </Card>
      ))}
    </ScrollView>
  );
}
