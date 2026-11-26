# Präsentationsmodus (iOS) – Beamer zeigt nur die Seite

In der Expo-App ([ios/](../ios)) gibt es auf dem Blatt-Screen („Neues Blatt“ /
`app/pencil.tsx`) einen Button **„Präsentation“**.

## Verhalten

- **Auf dem iPhone/iPad bleibt alles normal bedienbar** (Werkzeuge, Titel,
  Speichern, Zoom …) – das Gerät verliert nichts.
- **Auf dem externen Display (Beamer / Projektor) wird keine UI gezeigt**, nur
  die aktuelle Seite. Sobald man zeichnet, wird die Seite laufend (alle 350 ms)
  auf den Beamer gespiegelt; Hintergrund weiß, Inhalt zentriert (`scaleAspectFit`).
- **„Präsentation beenden“** entfernt das Beamer-Fenster; beim Verlassen des
  Blatt-Screens wird der Modus automatisch beendet. Trennen des Beamers beendet
  ihn ebenfalls.

## Anschluss / AirPlay

- **Kabel:** Lightning-/USB-C-zu-HDMI-Adapter oder direkt HDMI (iPad). iOS meldet
  das zweite `UIScreen`.
- **AirPlay:** Gerät + Beamer im selben WLAN, Control Center → **Screen
  Mirroring** → Beamer wählen. Der App-Code behandelt sowohl ein eigenes externes
  Display als auch die Spiegelung (`UIScreen.main.mirrored`) und legt dann ein
  eigenes, reines Seiten-Fenster auf den Beamer. *(Auf echter Hardware
  verifizieren; in dieser Linux-Umgebung nicht baubar.)*
- Wenn nichts verbunden ist, sagt der Button das („Kein Beamer / externes Display
  verbunden.“).

## Technik

- Lokales Expo-Modul **`ExternalDisplay`** in
  [ios/modules/external-display](../ios/modules/external-display):
  - iOS/Swift `ExternalDisplayModule.swift`: beobachtet `UIScreen.didConnectNotification`
    / `didDisconnectNotification` / `modeDidChangeNotification`, erzeugt ein
    zusätzliches `UIWindow` auf dem externen `UIScreen` mit einem reinen
    `UIImageView` (keine React-Native-/UI-Elemente, keine Toolbar), **ohne**
    `makeKeyAndVisible()` – das Hauptfenster bleibt key.
  - JS-Wrapper [ios/services/externalDisplay.ts](../ios/services/externalDisplay.ts):
    `startPresentationMode`, `stopPresentationMode`, `setExternalImageBase64`,
    `setExternalImageUri`, `addExternalDisplayListener`, …; sichere No-Ops ohne
    natives Modul (Web / Expo Go).
  - Seiteninhalt kommt aus `ExpoPencilkit.exportImage()` (PNG-Base64) – dieselbe
    Quelle wie beim Speichern.
- Events: `onConnected`, `onDisconnected`, `onAvailabilityChange`,
  `onPresentationChange`.

## Build

Ein **nativer Rebuild** ist nötig (Expo-Dev-Client, kein Expo Go):

```sh
cd ios
npx expo prebuild            # generiert ios/, linkt das lokale Modul automatisch
npx expo run:ios             # bzw. EAS-Build
# oder: eas build --platform ios --profile development
```

Auf iOS muss nichts in Info.plist ergänzt werden; das Modul registriert sich per
Expo-Autolinking. iOS-Build läuft nur auf macOS + Xcode (siehe
[docs/ios-release-builds.md](ios-release-builds.md)).
