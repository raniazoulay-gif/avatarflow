import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { colors, styles } from './components/ui';
import { s, setLang } from './lib/i18n';
import { controller, wireEnvironment } from './lib/location';
import { onNotificationTap } from './lib/push';
import { SessionProvider, useSession, type FamilyRef } from './lib/session';
import { AuthScreen } from './screens/AuthScreen';
import { DriverScreen } from './screens/DriverScreen';
import { JoinScreen } from './screens/JoinScreen';
import { ParentScreen } from './screens/ParentScreen';
import { SosScreen } from './screens/SosScreen';

setLang('he');

function Root() {
  const { ready, user, families, signOut } = useSession();
  const [view, setView] = useState<'main' | 'sos' | 'parent'>('main');

  useEffect(() => {
    wireEnvironment();
  }, []);
  useEffect(() => {
    if (user) void controller.resume().catch(() => undefined);
  }, [user]);
  useEffect(() => onNotificationTap(() => setView('main')), []);

  if (!ready)
    return (
      <View style={[styles.screen, { justifyContent: 'center' }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  if (!user) return <AuthScreen />;

  const driverFamily: FamilyRef | undefined = families.find((f) => f.driverId);
  const parentFamily: FamilyRef | undefined = families.find((f) => f.role === 'PARENT');
  if (!driverFamily && !parentFamily) return <JoinScreen />;

  const family = (view === 'parent' ? parentFamily : driverFamily) ?? parentFamily ?? driverFamily;
  if (!family) return <JoinScreen />;

  return (
    <View style={styles.screen}>
      <View style={[styles.between, { paddingHorizontal: 16, paddingVertical: 8 }]}>
        <Text style={styles.h2}>SafeDrive · {user.displayName}</Text>
        <View style={styles.row}>
          {driverFamily && parentFamily && (
            <Tab
              label={view === 'parent' ? s('startDriving') : s('liveTrips')}
              onPress={() => setView(view === 'parent' ? 'main' : 'parent')}
            />
          )}
          <Tab label={s('logout')} onPress={signOut} />
        </View>
      </View>
      {view === 'sos' && <SosScreen family={family} onBack={() => setView('main')} />}
      {view !== 'sos' && (view === 'parent' || !driverFamily?.driverId) && parentFamily && (
        <ParentScreen family={parentFamily} />
      )}
      {view === 'main' && driverFamily?.driverId && (
        <DriverScreen driverId={driverFamily.driverId} onSos={() => setView('sos')} />
      )}
    </View>
  );
}

function Tab({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={{ padding: 6 }}>
      <Text style={{ color: colors.primary, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <StatusBar style="dark" />
        <SessionProvider>
          <Root />
        </SessionProvider>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
