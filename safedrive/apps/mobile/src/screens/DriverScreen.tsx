import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { Banner, Button, Card, SEVERITY_COLORS, colors, styles } from '../components/ui';
import { call } from '../lib/api';
import { demoRunning, startDemo, stopDemo } from '../lib/demo';
import { s, tc } from '../lib/i18n';
import { controller } from '../lib/location';
import { NAVIGATION_PROVIDERS, openNavigationApp } from '../lib/navigation';
import { PhoneUsageDetector } from '../lib/phone-usage';
import { registerDevice } from '../lib/push';
import { useController } from '../lib/use-controller';

interface MonitoringRequest {
  id: string;
  driverId: string;
  status: string;
  requestedBy: string;
}

/** Driver home (START DRIVING) and the live driving view. */
export function DriverScreen({ driverId, onSos }: { driverId: string; onSos: () => void }) {
  const snap = useController();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [requests, setRequests] = useState<MonitoringRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const detector = useMemo(
    () => new PhoneUsageDetector((d) => controller.report('PHONE_USAGE', d)),
    [],
  );

  useEffect(() => controller.setDriver(driverId), [driverId]);
  useEffect(() => {
    void registerDevice(snap.permission).then(setDeviceId);
  }, [snap.permission]);

  const loadRequests = useCallback(async () => {
    try {
      setRequests(
        (await call<MonitoringRequest[]>('/me/monitoring-requests')).filter(
          (r) => r.driverId === driverId,
        ),
      );
    } catch {
      // offline - keep the last list
    }
  }, [driverId]);
  useEffect(() => {
    void loadRequests();
    const t = setInterval(loadRequests, 20_000);
    return () => clearInterval(t);
  }, [loadRequests]);

  const start = async (monitoringRequestId?: string) => {
    setBusy(true);
    const ok = await controller.start(driverId, deviceId, {
      monitoringRequestId: monitoringRequestId ?? null,
    });
    setBusy(false);
    if (monitoringRequestId) void loadRequests();
    if (!ok && controller.snapshot.error) Alert.alert(s('error'), controller.snapshot.error);
  };

  const decline = async (id: string) => {
    await call(`/monitoring-requests/${id}/respond`, 'POST', { status: 'DECLINED' }).catch(
      () => undefined,
    );
    void loadRequests();
  };

  const confirmSos = () =>
    Alert.alert(s('sos'), s('sosConfirm'), [
      { text: s('back'), style: 'cancel' },
      {
        text: s('sos'),
        style: 'destructive',
        onPress: async () => {
          await controller.sos().catch(() => undefined);
          Alert.alert(s('sos'), controller.snapshot.pendingSos ? s('sosQueued') : s('sosSent'));
          onSos();
        },
      },
    ]);

  const live = snap.live;
  const active = snap.tripId !== null;
  const sev = live?.severity ?? 'SAFE';

  if (!active) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.pad}>
        {!snap.online && <Banner text={s('offline')} color={colors.muted} />}
        {requests.map((r) => (
          <Card key={r.id} style={{ borderColor: colors.primary, borderWidth: 2 }}>
            <Text style={styles.h2}>{s('monitoringRequest', { name: r.requestedBy })}</Text>
            <View style={styles.row}>
              <Button
                title={s('accept')}
                onPress={() => start(r.id)}
                busy={busy}
                style={{ flex: 1 }}
              />
              <Button
                kind="ghost"
                title={s('decline')}
                onPress={() => decline(r.id)}
                style={{ flex: 1 }}
              />
            </View>
          </Card>
        ))}
        <Button big title={s('startDriving')} onPress={() => start()} busy={busy} />
        <Card>
          <Text style={styles.h2}>{s('permissions')}</Text>
          <PermRow
            label={s('locFg')}
            ok={snap.permission === 'foreground' || snap.permission === 'background'}
          />
          <PermRow label={s('locBg')} ok={snap.permission === 'background'} />
          {snap.permission === 'foreground' && (
            <Text style={styles.muted}>{s('bgMissingHint')}</Text>
          )}
          <Text style={[styles.h2, { marginTop: 8 }]}>{s('phoneUsage')}</Text>
          <Text style={styles.muted}>{s('phoneUsageHint')}</Text>
        </Card>
        {snap.pendingSos > 0 && <Banner text={s('sosQueued')} color={colors.danger} />}
        <Button kind="danger" title={s('sos')} onPress={confirmSos} />
        <Button
          kind="ghost"
          title={s('demo')}
          onPress={() => void startDemo(driverId, 'full', 1)}
        />
      </ScrollView>
    );
  }

  const unavailable =
    live?.state === 'SPEED_LIMIT_UNAVAILABLE' || (live !== null && live.limitKmh === null);
  return (
    <Pressable
      style={styles.screen}
      onPress={() => void detector.onInteraction(live?.speedKmh ?? null, snap.isDemo)}
    >
      <ScrollView contentContainerStyle={styles.pad}>
        <Banner
          text={snap.state === 'REMOTE_MONITORING_ACTIVE' ? s('remoteOn') : s('monitoringOn')}
          color={colors.primary}
        />
        {snap.isDemo && <Banner text={s('demoBadge')} color="#7c3aed" />}
        {!snap.online && (
          <Banner
            text={`${s('offline')} · ${s('queued', { n: snap.queued })}`}
            color={colors.muted}
          />
        )}
        <View
          style={{
            backgroundColor: unavailable ? colors.muted : SEVERITY_COLORS[sev],
            borderRadius: 24,
            padding: 24,
            alignItems: 'center',
          }}
          accessibilityLiveRegion="polite"
        >
          <Text style={{ color: '#fff', fontSize: 28, fontWeight: '800' }}>
            {unavailable ? tc('speed.limitUnavailable') : tc(`severity.${sev}`)}
          </Text>
          <Text style={{ color: '#fff', fontSize: 84, fontWeight: '900' }}>
            {live?.speedKmh !== null && live?.speedKmh !== undefined
              ? Math.round(live.speedKmh)
              : '--'}
          </Text>
          <Text style={{ color: '#fff', fontSize: 18 }}>{tc('unit.kmh')}</Text>
          {live?.confirming && (
            <Text style={{ color: '#fff', fontSize: 16, marginTop: 6 }}>{s('confirming')}</Text>
          )}
        </View>
        <Card>
          <Stat
            label={tc('speed.limit')}
            value={live?.limitKmh ? `${live.limitKmh} ${tc('unit.kmh')}` : '—'}
          />
          <Stat
            label={tc('speed.excess')}
            value={
              live && live.excessKmh > 0
                ? `${Math.round(live.excessKmh)} ${tc('unit.kmh')} (${Math.round(live.excessPct)}%)`
                : '—'
            }
          />
          <Stat
            label={tc('speed.duration')}
            value={live?.speedingSeconds ? s('speedingFor', { sec: live.speedingSeconds }) : '—'}
          />
          {unavailable && <Text style={styles.muted}>{s('noLimit')}</Text>}
        </Card>
        <View style={styles.row}>
          {NAVIGATION_PROVIDERS.map((p) => (
            <Button
              key={p.id}
              kind="ghost"
              title={p.label}
              onPress={() => void openNavigationApp(p.id)}
              style={{ flex: 1 }}
            />
          ))}
        </View>
        <Button big kind="danger" title={s('sos')} onPress={confirmSos} />
        <Button
          kind="ghost"
          title={s('endDriving')}
          onLongPress={() => {
            if (demoRunning()) stopDemo(true);
            else void controller.stop();
          }}
        />
      </ScrollView>
    </Pressable>
  );
}

function PermRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <View style={styles.between}>
      <Text style={styles.p}>{label}</Text>
      <Text style={{ color: ok ? SEVERITY_COLORS.SAFE : colors.danger, fontWeight: '700' }}>
        {ok ? s('granted') : s('missing')}
      </Text>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.between}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={[styles.p, { fontWeight: '700' }]}>{value}</Text>
    </View>
  );
}
