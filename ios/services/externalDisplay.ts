/**
 * Präsentationsmodus auf externem Display (Beamer / Projektor / AirPlay).
 *
 * Wrappt das lokale Expo-Modul `ExternalDisplay`
 * (`modules/external-display`, iOS). Auf dem Gerät bleibt alles normal
 * bedienbar; auf dem externen Bildschirm wird **keine UI** gezeigt,
 * sondern nur der übergebene Seiteninhalt.
 *
 * Auf Plattformen ohne natives Modul (z. B. Web / Expo Go ohne Rebuild)
 * sind alle Funktionen sichere No-Ops.
 */
import { Platform } from 'react-native';
import { requireNativeModule } from 'expo-modules-core';

export type ExternalScreenInfo = {
  width: number;
  height: number;
  scale: number;
  maximumFramesPerSecond?: number;
};

export type ExternalDisplayEvent =
  | 'onConnected'
  | 'onDisconnected'
  | 'onAvailabilityChange'
  | 'onPresentationChange';

export type PresentationChangeEvent = {
  active: boolean;
  connected: boolean;
};

type NativeSubscription = { remove: () => void };

type ExternalDisplayNativeModule = {
  isAvailable(): Promise<boolean>;
  isPresentationActive(): Promise<boolean>;
  getScreenInfo(): Promise<ExternalScreenInfo | null>;
  startPresentation(): Promise<boolean>;
  stopPresentation(): Promise<void>;
  setImageBase64(base64: string): Promise<void>;
  setImageUri(uri: string): Promise<void>;
  clearImage(): Promise<void>;
  setBackgroundColor(hex: string): Promise<void>;
  addListener(eventName: ExternalDisplayEvent, listener: (event: any) => void): NativeSubscription;
};

let nativeModule: ExternalDisplayNativeModule | null = null;

if (Platform.OS === 'ios') {
  try {
    nativeModule = requireNativeModule<ExternalDisplayNativeModule>('ExternalDisplay');
  } catch {
    // Natives Modul nicht gebaut (z. B. Expo Go) → No-Op-Fallback.
    nativeModule = null;
  }
}

/** true, wenn das native ExternalDisplay-Modul verfügbar ist. */
export function isExternalDisplaySupported(): boolean {
  return nativeModule != null;
}

/** true, wenn ein externes Display (Beamer) angeschlossen ist. */
export async function isExternalDisplayAvailable(): Promise<boolean> {
  if (!nativeModule) return false;
  try {
    return await nativeModule.isAvailable();
  } catch {
    return false;
  }
}

/** true, wenn der Präsentationsmodus aktiv ist. */
export async function isPresentationActive(): Promise<boolean> {
  if (!nativeModule) return false;
  try {
    return await nativeModule.isPresentationActive();
  } catch {
    return false;
  }
}

/** Infos zum externen Bildschirm (Auflösung in Punkten) oder null. */
export async function getExternalScreenInfo(): Promise<ExternalScreenInfo | null> {
  if (!nativeModule) return null;
  try {
    return await nativeModule.getScreenInfo();
  } catch {
    return null;
  }
}

/**
 * Präsentationsmodus starten: externes Fenster auf dem Beamer anlegen,
 * das nur die Seite zeigt (keine UI). Liefert true, wenn ein externes
 * Display angeschlossen ist und das Fenster erzeugt wurde.
 */
export async function startPresentationMode(): Promise<boolean> {
  if (!nativeModule) return false;
  try {
    return await nativeModule.startPresentation();
  } catch {
    return false;
  }
}

/** Präsentationsmodus beenden: externes Fenster entfernen. */
export async function stopPresentationMode(): Promise<void> {
  if (!nativeModule) return;
  try {
    await nativeModule.stopPresentation();
  } catch {
    // noop
  }
}

/** Seiteninhalt als PNG (rohes Base64 oder data-URI) auf den Beamer schieben. */
export async function setExternalImageBase64(base64: string): Promise<void> {
  if (!nativeModule) return;
  try {
    await nativeModule.setImageBase64(base64);
  } catch {
    // noop
  }
}

/** Seiteninhalt als Bilddatei (Pfad oder file://-URI) auf den Beamer schieben. */
export async function setExternalImageUri(uri: string): Promise<void> {
  if (!nativeModule) return;
  try {
    await nativeModule.setImageUri(uri);
  } catch {
    // noop
  }
}

/** Seiteninhalt auf dem Beamer leeren (nur Hintergrund bleibt). */
export async function clearExternalImage(): Promise<void> {
  if (!nativeModule) return;
  try {
    await nativeModule.clearImage();
  } catch {
    // noop
  }
}

/** Hintergrundfarbe des Beamer-Fensters setzen (#RGB / #RRGGBB). */
export async function setExternalBackgroundColor(hex: string): Promise<void> {
  if (!nativeModule) return;
  try {
    await nativeModule.setBackgroundColor(hex);
  } catch {
    // noop
  }
}

/** Event-Listener (onConnected / onDisconnected / onAvailabilityChange / onPresentationChange). */
export function addExternalDisplayListener(
  eventName: ExternalDisplayEvent,
  listener: (event: any) => void,
): () => void {
  if (!nativeModule || typeof nativeModule.addListener !== 'function') {
    return () => undefined;
  }
  try {
    const subscription = nativeModule.addListener(eventName, listener);
    return () => {
      try {
        subscription?.remove?.();
      } catch {
        // noop
      }
    };
  } catch {
    return () => undefined;
  }
}
