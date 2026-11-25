import { useRouter } from 'expo-router';
import { Button, ScrollView, Text, View } from 'react-native';
import { useEffect, useState } from 'react';
import { query } from '../services/sqlite';
import { syncNow } from '../services/sync';
import type { PbNote } from '../services/types';
import { formatDateTime } from '../utils/ui';

export default function HomeScreen() {
  const router = useRouter();
  const [notes, setNotes] = useState<PbNote[]>([]);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const load = async () => {
    setNotes(
      await query<PbNote>(
        'SELECT id, title, created, updated FROM notes WHERE deleted = 0 ORDER BY created DESC LIMIT 50',
      ),
    );
  };

  useEffect(() => {
    void load();
  }, []);

  const handleSync = async () => {
    const result = await syncNow();
    setSyncMsg(result.ok ? `Synchronisiert (${result.uploaded} hochgeladen)` : `Fehler: ${result.error}`);
  };

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Text style={{ fontSize: 28, fontWeight: '800', marginBottom: 12 }}>Federwerk</Text>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <Button title="Neues Blatt" onPress={() => router.push('/pencil')} />
        <Button title="Lern-Erinnerungen" onPress={() => router.push('/learn')} />
        <Button title="Sync" onPress={handleSync} />
        <Button title="Einstellungen" onPress={() => router.push('/settings')} />
      </View>
      {syncMsg && (
        <Text style={{ color: '#B91C1C', marginBottom: 8 }}>{syncMsg}</Text>
      )}
      <ScrollView>
        {notes.length === 0 ? (
          <Text style={{ color: '#7A7A7A' }}>Keine lokalen Notizen.</Text>
        ) : (
          notes.map((note) => (
            <View key={note.id} style={{ padding: 12, marginVertical: 4, backgroundColor: '#FAFAF5', borderRadius: 12 }}>
              <Text style={{ fontWeight: '600' }}>{note.title}</Text>
              <Text style={{ color: '#7A7A7A', fontSize: 12 }}>{formatDateTime(note.created)}</Text>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}
