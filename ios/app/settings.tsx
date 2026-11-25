import { ScrollView, Text, TextInput, View, Switch, Button } from 'react-native';
import { useEffect, useState } from 'react';
import { PB_URL } from '../services/pocketbase';
import { syncNow } from '../services/sync';
import { requestNotificationPermission, registerPushToken, getAllScheduledReminders } from '../services/reminders';

export default function SettingsScreen() {
  const [backendUrl, setBackendUrl] = useState<string>(PB_URL);
  const [syncMsg, setSyncMsg] = useState<string>('');
  const [pushGranted, setPushGranted] = useState<boolean | null>(null);
  const [scheduledCount, setScheduledCount] = useState(0);

  useEffect(() => {
    void requestNotificationPermission().then((ok) => setPushGranted(ok));
    void getAllScheduledReminders().then((items) => setScheduledCount(items.length));
  }, []);

  const doSync = async () => {
    const result = await syncNow();
    setSyncMsg(result.ok ? `Synchronisiert: ${result.uploaded} hochgeladen` : `Fehler: ${result.error ?? 'unbekannt'}`);
  };

  return (
    <ScrollView style={{ padding: 16 }}>
      <Text style={{ fontSize: 28, fontWeight: '800', marginBottom: 12 }}>Einstellungen</Text>

      <Text style={{ fontWeight: '600', marginTop: 12 }}>Backend</Text>
      <TextInput
        style={{ padding: 10, backgroundColor: '#FAFAF5', borderRadius: 8, borderColor: '#D6D3D2', borderWidth: 1, marginTop: 4 }}
        value={backendUrl}
        onChangeText={setBackendUrl}
        autoCapitalize="none"
        placeholder="PocketBase-URL"
      />
      <Text style={{ color: '#7A7A7A', fontSize: 12, marginTop: 4 }}>{PB_URL}</Text>

      <Text style={{ fontWeight: '600', marginTop: 16 }}>Offline-Sync</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 8 }}>
        <Switch value={Boolean(syncMsg)} onValueChange={() => undefined} />
        <Text>Lokale Notizen synchronisieren (SQLite + Sync-Queue)</Text>
      </View>
      <Button title="Jetzt synchronisieren" onPress={doSync} />
      {syncMsg && <Text style={{ color: '#7A7A7A', fontSize: 12, marginTop: 4 }}>{syncMsg}</Text>}

      <Text style={{ fontWeight: '600', marginTop: 16 }}>Push-Benachrichtigungen</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Switch value={pushGranted ?? false} onValueChange={() => undefined} />
        <Text>Benachrichtigungen erlaubt: {String(pushGranted ?? '?')}</Text>
      </View>
      <Button title="Push-Token beim Backend registrieren" onPress={registerPushToken} />
      <Text style={{ color: '#7A7A7A', fontSize: 12, marginTop: 4 }}>Geplante Erinnerungen: {scheduledCount}</Text>
    </ScrollView>
  );
}
