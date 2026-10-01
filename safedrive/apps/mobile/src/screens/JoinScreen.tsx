import { useState } from 'react';
import { ScrollView, Switch, Text, View } from 'react-native';
import { Button, Card, Field, styles } from '../components/ui';
import { call } from '../lib/api';
import { s } from '../lib/i18n';
import { useSession } from '../lib/session';

/** Driver joins with an invite code and explicit consent (required for drivers). */
export function JoinScreen() {
  const { reload, signOut } = useSession();
  const [code, setCode] = useState('');
  const [consent, setConsent] = useState(false);
  const [family, setFamily] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.pad, { paddingTop: 60 }]}>
      <Text style={styles.h1}>{s('joinTitle')}</Text>
      <Card>
        <Field
          label={s('inviteCode')}
          value={code}
          onChangeText={setCode}
          autoCapitalize="characters"
        />
        <View style={[styles.row, { alignItems: 'flex-start' }]}>
          <Switch value={consent} onValueChange={setConsent} accessibilityLabel={s('consent')} />
          <Text style={[styles.p, { flex: 1 }]}>{s('consent')}</Text>
        </View>
        <Button
          title={s('join')}
          busy={busy}
          disabled={code.trim().length < 6}
          onPress={() => run(() => call('/invites/accept', 'POST', { code: code.trim(), consent }))}
        />
      </Card>
      <Card>
        <Text style={styles.h2}>{s('createFamily')}</Text>
        <Field label={s('familyName')} value={family} onChangeText={setFamily} />
        <Button
          kind="ghost"
          title={s('create')}
          busy={busy}
          disabled={!family.trim()}
          onPress={() => run(() => call('/families', 'POST', { name: family.trim() }))}
        />
      </Card>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button
        kind="ghost"
        title={s('logout')}
        onPress={() => void signOut().catch(() => undefined)}
      />
    </ScrollView>
  );
}
