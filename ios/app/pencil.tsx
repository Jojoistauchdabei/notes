import ExpoPencilkit, { type ExpePencilKitViewMethods, type ExportImageResult } from '@noripi10/expo-pencilkit';
import * as FileSystem from 'expo-file-system';
import { Button, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { enqueueNote } from '../services/sync';
import {
  addExternalDisplayListener,
  isExternalDisplayAvailable,
  isExternalDisplaySupported,
  setExternalBackgroundColor,
  setExternalImageBase64,
  startPresentationMode,
  stopPresentationMode,
} from '../services/externalDisplay';
import type { PkNoteDraft } from '../services/types';
import { randomId } from '../utils/ui';

export default function PencilScreen() {
  const router = useRouter();
  const pencilKitRef = useRef<ExpePencilKitViewMethods | null>(null);
  const [title, setTitle] = useState('Notiz');
  const [panZoom, setPanZoom] = useState(false);

  // Präsentationsmodus: App bleibt normal bedienbar, externer Beamer zeigt nur die Seite.
  const [presentation, setPresentation] = useState(false);
  const [externalAvailable, setExternalAvailable] = useState(false);
  const [presentationMsg, setPresentationMsg] = useState<string | null>(null);
  const presentationRef = useRef(false);
  useEffect(() => { presentationRef.current = presentation; }, [presentation]);

  const refreshExternalAvailability = useCallback(async () => {
    setExternalAvailable(await isExternalDisplayAvailable());
  }, []);

  useEffect(() => {
    void refreshExternalAvailability();
    const offConnected = addExternalDisplayListener('onConnected', () => { void refreshExternalAvailability(); });
    const offDisconnected = addExternalDisplayListener('onDisconnected', () => {
      void refreshExternalAvailability();
      if (presentationRef.current) setPresentationMsg('Beamer getrennt – Präsentation beendet.');
      setPresentation(false);
    });
    const offAvailability = addExternalDisplayListener('onAvailabilityChange', () => { void refreshExternalAvailability(); });
    return () => { offConnected(); offDisconnected(); offAvailability(); };
  }, [refreshExternalAvailability]);

  // Beim Verlassen der Seite Präsentationsmodus beenden.
  useEffect(() => {
    return () => { void stopPresentationMode(); };
  }, []);

  // Solange der Präsentationsmodus aktiv ist, laufend die aktuelle Seite
  // (PencilKit-Export) auf den Beamer schieben. Keine UI, nur die Seite.
  useEffect(() => {
    if (!presentation) return;
    let cancelled = false;
    let inFlight = false;

    const pushFrame = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const exported = await pencilKitRef.current?.exportImage?.();
        const base64 = exported?.base64;
        if (!cancelled && base64) {
          await setExternalImageBase64(base64);
        }
      } catch {
        // Frame überspringen.
      }
      inFlight = false;
    };

    void pushFrame();
    const interval = setInterval(() => { void pushFrame(); }, 350);
    return () => { cancelled = true; clearInterval(interval); };
  }, [presentation]);

  const togglePresentation = async () => {
    setPresentationMsg(null);
    if (presentation) {
      setPresentation(false);
      await stopPresentationMode();
      return;
    }
    if (!isExternalDisplaySupported()) {
      setPresentationMsg('Präsentationsmodus ist auf diesem Gerät nicht verfügbar.');
      return;
    }
    const started = await startPresentationMode();
    if (started) {
      setPresentation(true);
      await setExternalBackgroundColor('#FFFFFF');
      setPresentationMsg('Präsentation aktiv – Beamer zeigt nur die Seite.');
    } else {
      setPresentation(false);
      setPresentationMsg('Kein Beamer / externes Display verbunden.');
    }
  };

  const save = async () => {
    const exported: ExportImageResult | undefined = await pencilKitRef.current?.exportImage?.();
    let imageData: string | null = null;
    if (exported) {
      const dest = `${FileSystem.cacheDirectory ?? 'file:///tmp/'}federwerk-${randomId()}.png`;
      if (exported.path) {
        await FileSystem.copyAsync({ from: exported.path, to: dest }).catch(() => undefined);
      }
      imageData = exported.base64 ?? null;
    }
    const now = new Date().toISOString();
    const id = randomId();
    const draft: PkNoteDraft = {
      id,
      title,
      image_data: imageData,
      created: now,
      updated: now,
      starred: false,
    };
    await enqueueNote(draft);
    router.back();
  };

  // Pan/Zoom-Modus an/aus: beim Reinzoomen wird das Zeichnen kurz unterbrochen,
  // die Zoomstufe bleibt beim Zurückschalten in den Schreibmodus erhalten.
  const togglePanZoom = async () => {
    const next = !panZoom;
    await pencilKitRef.current?.setPanZoomMode(next);
    setPanZoom(next);
  };

  // Zoom zurück auf 100 %.
  const resetZoom = async () => {
    await pencilKitRef.current?.resetZoom();
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: 16, flexDirection: 'row', gap: 8 }}>
        <TextInput
          style={{ flex: 1, padding: 8, backgroundColor: '#FAFAF5', borderRadius: 8, borderColor: '#D6D3D2', borderWidth: 1 }}
          value={title}
          onChangeText={setTitle}
          placeholder="Titel"
        />
        <Button title="Speichern" onPress={save} />
      </View>
      <View style={{ paddingHorizontal: 16, paddingBottom: 8, flexDirection: 'row', gap: 8 }}>
        <Button title={panZoom ? 'Zurück zum Schreiben' : 'Zoom / Verschieben'} onPress={togglePanZoom} />
        <Button title="Zoom 100 %" onPress={resetZoom} />
        <Button
          title={presentation ? 'Präsentation beenden' : 'Präsentation'}
          onPress={() => { void togglePresentation(); }}
        />
      </View>
      {presentationMsg && (
        <Text style={{ paddingHorizontal: 16, paddingBottom: 8, color: presentation ? '#15803D' : '#7A7A7A' }}>
          {presentationMsg}
        </Text>
      )}
      {!presentationMsg && !externalAvailable && !presentation && (
        <Text style={{ paddingHorizontal: 16, paddingBottom: 8, color: '#7A7A7A', fontSize: 12 }}>
          Beamer verbinden (AirPlay / Lightning-HDMI / USB-C), dann „Präsentation“.
        </Text>
      )}
      <ExpoPencilkit ref={pencilKitRef} style={{ flex: 1 }} />
    </View>
  );
}
