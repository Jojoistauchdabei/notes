import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { init } from '../services/sqlite';
import { requestNotificationPermission } from '../services/reminders';

export default function RootLayout() {
  useEffect(() => {
    void init();
    void requestNotificationPermission();
  }, []);

  return <Stack screenOptions={{ headerStyle: { backgroundColor: '#FAFAF5' } }} />;
}
