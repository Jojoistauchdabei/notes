/** Push-Notifications für Lern-Erinnerungen (expo-notifications). */

import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { savePushToken } from './pocketbase';

const deviceName = Constants.deviceName ?? 'Federwerk iOS';

export async function requestNotificationPermission(): Promise<boolean> {
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

/** Lern-Erinnerung als lokale (Push-)Benachrichtigung planen. */
export async function scheduleReminder(title: string, message: string, date: Date): Promise<string | undefined> {
  return Notifications.scheduleNotificationAsync({
    identifier: `learn-${Date.now()}`,
    content: { title, body: message, sound: 'default' },
    trigger: { type: 'atDate', date },
  });
}

export async function getAllScheduledReminders(): Promise<Array<Notifications.ScheduledNotification>> {
  return Notifications.getAllScheduledNotificationsAsync();
}

/** Expo Push Token beim shared Backend registrieren. */
export async function registerPushToken(): Promise<void> {
  const token = await Notifications.getExpoPushTokenAsync();
  await savePushToken(token.data, deviceName);
}
