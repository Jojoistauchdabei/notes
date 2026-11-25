# iOS-Release-Builds – automatisch auf GitHub Releases

Automatisierte Pushes der **unsigned** iOS-Artefakte (iPad/iPhone) auf die
GitHub Releases von Federwerk.

## Wie es funktioniert

- Workflow: [tauri.yml](../.github/workflows/tauri.yml) → Job `ios`
- Runner: `macos-14` (Apple Silicon)
- Build: `npx --yes @tauri-apps/cli ios build --no-sign`
  (kein Signing, `--no-sign` – mit `--release` oder Debug-Modus: optional)
- Assets auf dem Release: alle `*.ipa` / `*.xcarchive` aus `src-tauri/gen/apple/build`
  werden per `gh release upload --clobber` an das Tag-Release gehängt.
- Auslöser: `release: published`, `workflow_dispatch` (existierender Tag) und der
  reuseable-Aufruf aus `auto-release.yml` – Release-Assets sind also automatisch da.

## Warum nicht Docker?

Xcode und das iOS-SDK laufen **nur auf macOS** – der Job braucht ein
macOS-Hostsystem (in der Praxis Apple Silicon). Auf diesem Linux-Host läuft die
Swift/Rust/Xcode-Toolchain nicht, und Docker (x86_64/Linux) bietet keine
verlässliche Umgebung, in der Xcode für iOS baut:

- [dockur/macos](https://github.com/dockur/macos) bringt macOS in Docker
  (QEMU/KVM) – aber Xcode ist Apple-Silicon/macOS-only, Nachinstallation
  und der Abgleich mit den Release-Assets sind mehr Aufwand als die Standardlösung.

Für Macs: Self-Hosted-Runner auf Apple Silicon mit [Tart](https://tart.run)
(z. B. [Tartelet](https://github.com/shapehq/tartelet), Runner-Images
`tart clone ghcr.io/cirruslabs/macos-sequoia-xcode:16.3 …`), siehe
[Joseph Duffy, Self-Hosting macOS GitHub Runners](https://josephduffy.co.uk/posts/self-hosting-macos-github-runners).

## Artefaktnamen

Assets land unter `Federwerk-<tag>-*` bzw. in der genauen Tauri-Ausgabe, z. B.:

- `*.ipa` (unsigned, installierbar mit Alt-Klick auf Apple Silicon)
- `*.xcarchive` (Archive zum Rückportieren, wenn später signing eingerichtet wird)

## Sonstiges

- Ohne unsigned erhält man die Dateien nur als CI-Artifacts
  (`federwerk-unsigned-ios`), das Release-Upload ist bewusst optional
  (`::warning::` statt Fehler).
