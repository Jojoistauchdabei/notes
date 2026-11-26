import ExpoPencilkit, { type ExpePencilKitViewMethods, type ExportImageResult } from '@noripi10/expo-pencilkit';
import * as FileSystem from 'expo-file-system';
import { Button, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { enqueueNote } from '../services/sync';
import type { PkNoteDraft } from '../services/types';
import { randomId } from '../utils/ui';

export default function PencilScreen() {
  const router = useRouter();
  const pencilKitRef = useRef<ExpePencilKitViewMethods | null>(null);
  const [title, setTitle] = useState('Notiz');
  const [panZoom, setPanZoom] = useState(false);

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
      </View>
      <ExpoPencilkit ref={pencilKitRef} style={{ flex: 1 }} />
    </View>
  );
}
