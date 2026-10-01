import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text } from 'react-native';
import { Button, Card, Field, styles } from '../components/ui';
import { s, tc } from '../lib/i18n';
import { useSession } from '../lib/session';

export function AuthScreen() {
  const { signIn } = useSession();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      if (mode === 'login') await signIn('/auth/login', { email, password });
      else await signIn('/auth/register', { email, password, displayName: name, locale: 'he' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={[styles.pad, { paddingTop: 80 }]}>
        <Text style={[styles.h1, { fontSize: 34 }]}>SafeDrive</Text>
        <Text style={styles.muted}>{tc('app.tagline')}</Text>
        <Card>
          {mode === 'register' && <Field label={s('name')} value={name} onChangeText={setName} />}
          <Field
            label={s('email')}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
          />
          <Field
            label={s('password')}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="password"
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Button
            title={mode === 'login' ? s('login') : s('register')}
            onPress={submit}
            busy={busy}
          />
          <Button
            kind="ghost"
            title={mode === 'login' ? s('noAccount') : s('haveAccount')}
            onPress={() => setMode(mode === 'login' ? 'register' : 'login')}
          />
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
