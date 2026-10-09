#!/usr/bin/env bash
# Prueft server/gc.js gegen eine Fixture.
# Erwartet auf dem LXC: /tmp/gc.js, /tmp/schema.sql, /tmp/make-fixture.js
#
# Zwei Regeln, die beim Schreiben dieser Tests blutig teuer waren:
#
#   1. Der JSON-Auswertung muss DERSELBE Lauf zugrunde liegen, der geaendert
#      hat. Ein separates "nochmal ohne --cold laufen lassen" liest den
#      Zustand NACH der Aktion und liefert ueberall undefined zurueck.
#   2. Erwartete Pfade berechnen, nicht raten. Der Server legt Dateien
#      gesharded ab: sha[0:2]/sha[2:4]/sha.ext - aus 64 'b' wird bb/bb.
set -e
R=/tmp/gctest
DB=$R/data/users/alice/docs.db
SHA_B=$(printf 'b%.0s' $(seq 64))
FAILED=0

# Die Ablagepfade kommen aus der Umgebung, nicht aus file_tiers - genau so
# wie auf der Maschine. schema.sql hat bewusst keine Default-Pfade mehr
# (siehe Kommentar dort), also muss der Test sie hier setzen.
export FW_DATA_DIR=$R/data
export FW_FILES_DIR=$R/hot
export FW_ARCHIVE_DIR=$R/cold
mkdir -p $FW_FILES_DIR $FW_ARCHIVE_DIR

fresh() {
  rm -rf $R
  mkdir -p $R/data/users/alice $R/hot $R/cold
  node /tmp/make-fixture.js "$DB" $R/hot $R/cold >/dev/null
}

step()  { printf '\n\033[1m=== %s ===\033[0m\n' "$*"; }
expect() {
  if [ "$2" = "$3" ]; then printf '  OK   %s\n' "$1"
  else printf '  FAIL %s\n         erwartet: [%s]\n         bekommen: [%s]\n' "$1" "$2" "$3"; FAILED=1; fi
}
# Wert aus bereits vorliegendem JSON holen - startet gc.js NICHT neu.
jv() {
  printf '%s' "$1" | node -e '
    let s = "";
    process.stdin.on("data", d => s += d).on("end", () => {
      const j = JSON.parse(s);
      const v = eval(process.argv[1]);
      console.log(v === undefined ? "undefined" : v);
    });' "$2"
}
qdb() { # qdb <sql> <param...>  -> erstes Feld der ersten Zeile
  node -e '
    const {DatabaseSync} = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    const row = db.prepare(process.argv[2]).get(...process.argv.slice(3));
    console.log(row ? Object.values(row)[0] : "null");
    db.close();' "$@"
}
# Erwarteter Ablagepfad, identisch zur Sharding-Regel im Server.
fpath() { # fpath <base> <sha> <ext>
  printf '%s/%s/%s/%s.%s' "$1" "${2:0:2}" "${2:2:2}" "$2" "$3"
}

step "1. Bericht: alles wird gezahlt, nichts angefasst"
fresh
OUT=$(node /tmp/gc.js --data $R/data)
echo "$OUT" | sed 's/^/  /'
J=$(node /tmp/gc.js --data $R/data --json)
expect "verwaist: nur c"                "1"          "$(jv "$J" 'j.users[0].orphanCount')"
expect "kalt-Kandidaten: b + 9 (ref'd)" "2"          "$(jv "$J" 'j.users[0].coldCandidateCount')"
expect "verwaist c NICHT als kalt"      "true"       "$(jv "$J" 'j.users[0].orphanCount===1 && j.users[0].coldCandidateCount===2')"
expect "Datei ohne DB-Eintrag: 1"       "1"          "$(jv "$J" 'j.users[0].strayCount')"
expect "geloescht wurde nichts"         "0"          "$(jv "$J" 'j.users[0].deleted||0')"
expect "verschoben wurde nichts"        "0"          "$(jv "$J" 'j.users[0].coldMoved||0')"
expect "6 Dateien in der DB"            "6"          "$(qdb "$DB" 'select count(*) n from files')"

step "2. Idempotenz: Bericht ist stabil"
fresh
A=$(node /tmp/gc.js --data $R/data --json)
B=$(node /tmp/gc.js --data $R/data --json)
expect "zwei Berichte identisch"        "true"       "$(node -e 'console.log(process.argv[1]===process.argv[2])' "$A" "$B")"

step "3. Verriegelung: Dateien da, aber noch keine einzige Referenz"
rm -rf $R; mkdir -p $R/data/users/alice $R/hot $R/cold
node -e '
  const {DatabaseSync}=require("node:sqlite"); const fs=require("fs");
  const db=new DatabaseSync(process.argv[1]);
  db.exec(fs.readFileSync("/tmp/schema.sql","utf8"));
  db.prepare("UPDATE file_tiers SET path=? WHERE tier=?").run(process.argv[2],"hot");
  db.prepare("UPDATE file_tiers SET path=? WHERE tier=?").run(process.argv[3],"cold");
  db.prepare("INSERT INTO files VALUES (?,?,?,?,?,?)").run("a".repeat(64),999,"image/jpeg","hot",0,0);
  db.close();' "$DB" $R/hot $R/cold
OUT=$(node /tmp/gc.js --data $R/data --delete 2>&1 || true)
echo "$OUT" | grep -A3 "VERWEIGERT" | sed 's/^/  /'
J=$(node /tmp/gc.js --data $R/data --json)
expect "Verweigerung protokolliert"    "1"          "$(jv "$J" 'j.blocked.length')"
expect "trotz --delete Datei behalten" "1"          "$(qdb "$DB" 'select count(*) n from files')"

step "4. Kalt-Ablage: nur die mit Datei auf der Platte wandert"
fresh
J=$(node /tmp/gc.js --data $R/data --cold --json)
echo "$J" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const u=JSON.parse(s).users[0];console.log(`  verschoben: ${u.coldMoved}, Bytes: ${u.coldBytes}, Fehler: ${u.failures.length}`);console.log("  "+u.failures.map(f=>f.sha.slice(0,6)+": "+f.why).join("\n  "))})'
expect "1 echter Move (b)"             "1"          "$(jv "$J" 'j.users[0].coldMoved')"
expect "9 gemeldet, aber nicht verschoben" "1"      "$(jv "$J" 'j.users[0].failures.length')"
expect "b jetzt im Archiv"              "yes"       "$([ -f "$(fpath $R/cold $SHA_B pdf)" ] && echo yes || echo no)"
expect "b nicht mehr im heissen Pfad"   "no"        "$([ -f "$(fpath $R/hot $SHA_B pdf)" ] && echo yes || echo no)"
expect "b in der DB unveraendert"       "1"          "$(qdb "$DB" 'select count(*) n from files where sha256=?' "$SHA_B")"
expect "b jetzt als cold markiert"      "cold"      "$(qdb "$DB" 'select tier from files where sha256=?' "$SHA_B")"
expect "frisches a bleibt heiss"        "hot"       "$(qdb "$DB" 'select tier from files where sha256=?' "$(printf 'a%.0s' $(seq 64))")"

step "5. Rueckbau holt alles aus dem Archiv zurueck"
J=$(node /tmp/gc.js --data $R/data --restore-cold --json)
expect "2 zurueck (b + e; 9 fehlt)"     "2"          "$(jv "$J" 'j.users[0].restored')"
expect "b wieder heiss auf der Platte"  "yes"       "$([ -f "$(fpath $R/hot $SHA_B pdf)" ] && echo yes || echo no)"
expect "b wieder als hot markiert"      "hot"       "$(qdb "$DB" 'select tier from files where sha256=?' "$SHA_B")"

step "6. --delete nimmt ausschliesslich Verwaistes"
fresh
J=$(node /tmp/gc.js --data $R/data --delete --json)
expect "genau 1 geloescht (c)"           "1"          "$(jv "$J" 'j.users[0].deleted')"
expect "800 KB freigemacht"             "819200"     "$(jv "$J" 'j.users[0].freed')"
expect "5 Dateien uebrig"               "5"          "$(qdb "$DB" 'select count(*) n from files')"
expect "referenziertes b unbeschaedigt" "1"          "$(qdb "$DB" 'select count(*) n from files where sha256=?' "$SHA_B")"
expect "c auch von der Platte entfernt" "no"        "$([ -f "$(fpath $R/hot "$(printf 'c%.0s' $(seq 64))" png)" ] && echo yes || echo no)"
expect "f (ohne DB) unangetastet"       "yes"       "$([ -f $R/hot/ff/ff/$(printf 'f%.0s' $(seq 64)).bin ] && echo yes || echo no)"

step "7. Zweiter --delete ist ein No-op"
J=$(node /tmp/gc.js --data $R/data --delete --json)
expect "nichts mehr verwaist"           "0"          "$(jv "$J" 'j.users[0].orphanCount')"
expect "nichts geloescht"               "0"          "$(jv "$J" 'j.users[0].deleted||0')"

step "8. Nutzer-DB ohne Datei-Schema -> uebersprungen"
rm -rf $R/data/users; mkdir -p $R/data/users/carol
node -e 'const{DatabaseSync}=require("node:sqlite");new DatabaseSync(process.argv[1]).close();' "$R/data/users/carol/docs.db"
J=$(node /tmp/gc.js --data $R/data --json)
expect "kein Fehler"                    "0"          "$(jv "$J" 'j.errors.length')"
expect "kein Nutzer verarbeitet"        "0"          "$(jv "$J" 'j.users.length')"

step "9. Gar keine Nutzer-DBs"
rm -rf $R/data
J=$(node /tmp/gc.js --data $R/data --json)
expect "sauber beendet"                 "0"          "$(jv "$J" 'j.errors.length')"

rm -rf $R
printf '\n'
if [ "$FAILED" = "1" ]; then echo "ERGEBNIS: mindestens eine Pruefung fehlgeschlagen"; exit 1
else echo "ERGEBNIS: alle Pruefungen bestanden"; fi