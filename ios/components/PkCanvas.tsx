import { ExpoPencilkit, type ExportImageResult } from '@noripi10/expo-pencilkit';
import type { ComponentType, Ref } from 'react';
import type { ViewProps } from 'react-native';

type PkCanvasProps = ViewProps & {
  /** Zeichnungs-PNG als Base64 (für Vorschau/Stift-Syncing). */
  onExport?: (result: ExportImageResult | undefined) => void;
};

/** Wrapper um die Expo PencilKit-View (apple Pencil Support). */
export const PkCanvas: ComponentType<PkCanvasProps> = ExpoPencilkit as unknown as ComponentType<PkCanvasProps>;

export type { ExportImageResult };
