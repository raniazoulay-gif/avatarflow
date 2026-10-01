import { useEffect, useState } from 'react';
import { Linking, ScrollView, Text } from 'react-native';
import { countryProfile } from '@safedrive/core';
import { Button, Card, styles } from '../components/ui';
import { call } from '../lib/api';
import { s, tc } from '../lib/i18n';
import { type FamilyRef } from '../lib/session';

interface Contact {
  id: string;
  name: string;
  phone: string;
  relation: string | null;
}

/** Emergency numbers and contacts. Calls are placed only by the user's own tap (tel: link). */
export function SosScreen({ family, onBack }: { family: FamilyRef; onBack: () => void }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  useEffect(() => {
    call<Contact[]>(`/families/${family.id}/emergency-contacts`).then(setContacts, () => undefined);
  }, [family.id]);
  const profile = countryProfile(family.countryCode);
  const dial = (n: string) => void Linking.openURL(`tel:${n.replace(/[^\d+]/g, '')}`);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.pad}>
      <Text style={styles.h1}>{s('sos')}</Text>
      <Text style={styles.muted}>{s('sosHint')}</Text>
      {profile.emergencyNumbers.map((e) => (
        <Button key={e.number} big kind="danger" title={`${tc(e.labelKey)} · ${e.number}`} onPress={() => dial(e.number)} />
      ))}
      {contacts.length > 0 && (
        <Card>
          <Text style={styles.h2}>{s('emergencyContacts')}</Text>
          {contacts.map((c) => (
            <Button key={c.id} kind="ghost" title={`${c.name}${c.relation ? ` (${c.relation})` : ''} · ${c.phone}`} onPress={() => dial(c.phone)} />
          ))}
        </Card>
      )}
      <Button kind="ghost" title={s('back')} onPress={onBack} />
    </ScrollView>
  );
}
