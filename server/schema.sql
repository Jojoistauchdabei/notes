-- Federwerk: Dateiverwaltung (Dateiteil des Schemas).
--
-- Wird von server/db.js beim Anlegen einer Nutzer-DB ausgefuehrt und ist
-- zugleich die Schnittstelle fuer server/gc.js (Ausschuss + Kalt-Ablage).
-- Bewusst ausgelagert: der GC darf sich nicht auf halbfertigen Server-Code
-- verlassen, nur auf diese beiden Tabellen.
--
-- ----------------------------------------------------------------------------
-- Warum das ueberhaupt noetig ist
--
-- Die App ist offline-first und weiss clientseitig, welche Datei zu welchem
-- Dokument gehoert (js/appwrite-files.js: collectLocalEntries). Serverseitig
-- war diese Beziehung bisher nur implizit: Appwrite hat Dateien und Zeilen
-- unabhaengig verwaltet, die Verknuepfung ergab sich aus dem Dateinamen
-- fw<hash> im Referenzstring. Damit liess sich serverseitig nicht beantworten,
-- welche Datei noch gebraucht wird - die Datei-Existenz allein sagt nichts.
--
-- file_refs schliesst diese Luecke: der Server schreibt bei jedem
-- Dokument-PUT die enthaltenen Datei-Referenzen mit. Damit ist die
-- Frage "wird diese Datei noch verwendet?" eine Index-Abfrage.
-- ----------------------------------------------------------------------------

-- Eine Datei, physisch content-adressiert auf dem QNAP.
CREATE TABLE IF NOT EXISTS files (
  sha256        TEXT PRIMARY KEY,        -- 64 Hex, Quelle der Datei-Id (siehe unten)
  size          INTEGER NOT NULL,
  mime          TEXT,
  -- hot: liegt unter <files>/, cold: liegt unter <archive>/.
  -- Wird ausschliesslich von gc.js umgeschaltet; der Server liest beide.
  tier          TEXT NOT NULL DEFAULT 'hot' CHECK (tier IN ('hot','cold')),
  created_at    INTEGER NOT NULL,        -- Unix-Millisekunden
  -- Wird bei JEDEM serverseitigen Lesezugriff aktualisiert. Das ist das
  -- einzige Alterungssignal, dem wir trauen: kein Client meldet "ich nutze
  -- das nicht mehr", nur "ich habe es gelesen".
  last_used_at  INTEGER NOT NULL
) STRICT;

-- Wo die Ablage fuer hot/cold liegt.
--
-- Bewusst OHNE fest verdrahtete Pfade. Die Pfade kommen aus der
-- Umgebung (FW_FILES_DIR / FW_ARCHIVE_DIR, gesetzt in /etc/federwerk/env) und
-- haben Vorrang vor dieser Tabelle - siehe server/db.js:tierPaths().
--
-- Ein hier eingetragener Wert ist eine Ausnahme, kein Standard: er erlaubt,
-- einen Nutzer abweichend zu legen, ohne die Konfiguration anzufassen. Als
-- Default waere er gefaehrlich - ein falscher Pfad in der DB bedeutet, dass
-- der Server seine Dateien kommentarlos ins Leere schreibt, waehrend die
-- Konfiguration korrekt aussieht.
CREATE TABLE IF NOT EXISTS file_tiers (
  tier   TEXT PRIMARY KEY,
  path   TEXT NOT NULL
) STRICT;

-- Which documents reference which file. Bewusst ohne Fremdschluessel:
-- SQLite auf einer QNAS-naeheren Ablage soll moeglichst wenig Journaling
-- machen, und ein verwaistes file_refs-Eintrag ist harmlos - gc.js raeumt
-- ihn beim naechsten Lauf weg.
CREATE TABLE IF NOT EXISTS file_refs (
  sha256 TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  PRIMARY KEY (sha256, doc_id)
) STRICT;

-- Der GC-Aufruf: "welche heissen Dateien sind am aeltersten?"
CREATE INDEX IF NOT EXISTS idx_files_hot_last_used
  ON files (last_used_at) WHERE tier = 'hot';

-- Der GC-Aufruf: "welche Dateien hat gar keine Referenz mehr?"
-- Index auf sha256 genuegt; die Hauptabfrage laeuft ueber NOT EXISTS.
CREATE INDEX IF NOT EXISTS idx_file_refs_doc ON file_refs (doc_id);