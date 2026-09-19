// Federwerk Desktop-/Android-Shell (Tauri v2).
// Das eigentliche UI ist die bestehende PWA aus dist/ (tauri.conf.json → frontendDist).
// Plugins: updater (Desktop-Autoupdate via GitHub Releases), process (Neustart
// nach Update), opener (externe Links), dialog (Datei-Dialoge für Export/Import).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Desktop-Autoupdate: beim Start einmal prüfen, im Hintergrund
            // laden + installieren und danach neustarten. Still schlägt
            // fehl, wenn offline oder kein Update vorhanden – kein Dialog,
            // die Web-UI (js/updater.js) zeigt den Status als Banner.
            #[cfg(desktop)]
            {
                use tauri_plugin_updater::UpdaterExt;
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    match handle.updater() {
                        Ok(updater) => match updater.check().await {
                            Ok(Some(update)) => {
                                let version = update.version.clone();
                                eprintln!("Federwerk-Update gefunden: v{version} – lade …");
                                if let Err(e) =
                                    update.download_and_install(|_, _| {}, || {}).await
                                {
                                    eprintln!("Federwerk-Update fehlgeschlagen: {e}");
                                    return;
                                }
                                eprintln!("Federwerk-Update v{version} installiert – starte neu …");
                                handle.restart();
                            }
                            Ok(None) => eprintln!("Federwerk ist aktuell."),
                            Err(e) => eprintln!("Update-Check fehlgeschlagen (offline?): {e}"),
                        },
                        Err(e) => eprintln!("Updater nicht verfügbar: {e}"),
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Fehler beim Start von Federwerk");
}
