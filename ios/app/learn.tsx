import { Button, Text, TextInput, View, useColorScheme } from 'react-native';
import { useEffect, useState } from 'react';
import DatePickerModal from '@react-native-community/datetimepicker';
import * as Notifications from 'expo-notifications';
import { query, run } from '../services/sqlite';
import { randomId, formatDateTime } from '../utils/ui';

type LearningItem = { id: string; title: string; date: string };

export default function LearnScreen() {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState<Date>(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const [items, setItems] = useState<LearningItem[]>([]);
  const [pickerVisible, setPickerVisible] = useState(false);

  const load = async () => {
    const rows = await query<{ id: string; title: string; created_at: string }>(
      'SELECT id, title, created_at FROM learn_items ORDER BY created_at DESC LIMIT 20',
    );
    setItems(rows.map((row) => ({ id: row.id, title: row.title, date: row.created_at })));
  };

  useEffect(() => {
    void load();
  }, []);

  const addReminder = async () => {
    const label = title.trim() || 'Lern-Erinnerung';
    const id = await Notifications.scheduleNotificationAsync({
      identifier: `learn-${Date.now()}`,
      content: { title: label, body: 'Zeit für die Lernnacht.', sound: 'default' },
      trigger: { type: 'atDate', date },
    });
    await run('INSERT INTO learn_items (id, title, created_at) VALUES (?, ?, ?)', [id, label, date.toISOString()]);
    setTitle('');
    void load();
  };

  return (
    <View style={{ flex: 1, padding: 16, backgroundColor: useColorScheme() === 'dark' ? '#000' : '#FAFAF5' }}>
      <Text style={{ fontSize: 28, fontWeight: '800', marginBottom: 8 }}>Lern-Erinnerungen</Text>
      <Text style={{ color: '#7A7A7A', marginBottom: 16 }}>
        Erinnerungen werden als lokale Push-Benachrichtigungen geplant.
      </Text>

      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <TextInput
          style={{ flex: 1, minWidth: 160, padding: 10, backgroundColor: '#FAFAF5', borderRadius: 8, borderColor: '#D6D3D2', borderWidth: 1 }}
          value={title}
          onChangeText={setTitle}
          placeholder="Titel der Erinnerung"
        />
        <Button title="Wann?" onPress={() => setPickerVisible(true)} />
        <Button title="Erinnerung setzen" onPress={addReminder} />
      </View>

      {items.length > 0 && (
        <View style={{ marginBottom: 16 }}>
          <Text style={{ fontWeight: '600', marginBottom: 4 }}>Geplant</Text>
          {items.map((item) => (
            <View key={item.id} style={{ padding: 12, marginVertical: 4, backgroundColor: '#FAFAF5', borderRadius: 12 }}>
              <Text style={{ fontWeight: '600' }}>{item.title}</Text>
              <Text style={{ color: '#7A7A7A', fontSize: 12 }}>{formatDateTime(item.date)}</Text>
            </View>
          ))}
        </View>
      )}

      {pickerVisible && (
        <DatePickerModal
          isVisible
          date={date}
          mode="date"
          onDateChange={({ date }) => {
            if (date) setDate(date);
          }}
          onDismiss={() => setPickerVisible(false)}
        />
      )}
    </View>
  );
}
