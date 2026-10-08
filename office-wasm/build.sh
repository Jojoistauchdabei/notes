#!/usr/bin/env bash
# Baut das Office-WASM (DOCX/XLSX/PPTX-Bridge) und die wasm-bindgen-Glue.
#
# Aufruf: office-wasm/build.sh [Ausgabeordner]
# Default-Ausgabe: office-wasm/dist/  -> wird von scripts/build.js nach dist/
# kopiert, damit Web-ZIP und Desktop-Installer dieselbe Engine bekommen.
#
# Warum ein eigenes Skript und nicht `cargo build` direkt: wasm-bindgen-cli muss
# zur Version der wasm-bindgen-Crate passen, sonst schlaegt die Generierung
# fehl. Die holen wir hier als fertiges Binary, weil `cargo install
# wasm-bindgen-cli` auf einem CI-Runner Minuten frisst.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-$here/dist}"

cd "$here"

echo "::group::Rust"
rustc --version
cargo --version

echo "::group::Ziel wasm32-unknown-unknown nachinstallieren"
rustup target add wasm32-unknown-unknown

# wasm-bindgen-Version aus Cargo.lock lesen, damit CLI und Crate zusammenpassen.
wb_version="$(grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | grep '^version' | head -1 | sed -E 's/.*"([^"]+)".*/\1/')"
if [ -z "$wb_version" ]; then
  echo "::error::wasm-bindgen-Version nicht in Cargo.lock gefunden"
  exit 1
fi
echo "wasm-bindgen-Crate: ${wb_version}"

cli_dir="$here/.tooling"
mkdir -p "$cli_dir"

# Plattform des RUNNERS bestimmen, nicht des Ziels. Der Windows-Desktop-Job
# laeuft auf windows-latest: ein Linux-musl-Binary laesst sich dort nicht
# starten ("Exec format error"), darum muss die Auswahl passen.
os_name="$(uname -s)"
machine="$(uname -m)"
case "$os_name" in
  Linux)  case "$machine" in
            x86_64)  wa=x86_64-unknown-linux-musl ;;
            aarch64) wa=aarch64-unknown-linux-gnu ;;
            *) echo "::error::Linux-Architektur nicht unterstuetzt: $machine"; exit 1 ;;
          esac
          bin=wasm-bindgen ;;
  Darwin) case "$machine" in
            arm64)  wa=aarch64-apple-darwin ;;
            *)      wa=x86_64-apple-darwin ;;
          esac
          bin=wasm-bindgen ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
          if [ "$machine" != "x86_64" ]; then echo "::error::Windows-Architektur nicht unterstuetzt: $machine"; exit 1; fi
          wa=x86_64-pc-windows-msvc
          # Auf Windows heisst das Binary wasm-bindgen.exe.
          bin=wasm-bindgen.exe ;;
  *) echo "::error::Runner-Plattform nicht unterstuetzt: $os_name/$machine"; exit 1 ;;
esac
echo "Runner: ${os_name}/${machine} -> ${wa}"

if [ ! -x "$cli_dir/$bin" ]; then
  echo "::group::wasm-bindgen ${wb_version} fuer ${wa}"
  url="https://github.com/rustwasm/wasm-bindgen/releases/download/${wb_version}/wasm-bindgen-${wb_version}-${wa}.tar.gz"
  echo "hole $url"
  curl -fsSL "$url" | tar -xz -C "$cli_dir" --strip-components=1
  chmod +x "$cli_dir/$bin" 2>/dev/null || true
fi
# Gegenprobe: startet das Binary ueberhaupt? Auf der falschen Plattform
# faellt das erst beim Aufruf auf, dann ist die Fehlermeldung schwer lesbar.
if ! "$cli_dir/$bin" --version >/dev/null 2>&1; then
  echo "::error::wasm-bindgen aus $cli_dir laesst sich hier nicht ausfuehren (falsche Plattform?)."
  exit 1
fi
"$cli_dir/$bin" --version

echo "::group::cargo build --release --target wasm32-unknown-unknown"
# panic=abort + strip stehen in Cargo.toml; beides senkt die Groesse deutlich.
cargo build --release --target wasm32-unknown-unknown --lib

echo "::group::wasm-bindgen"
rm -rf "$out"
mkdir -p "$out"
"$cli_dir/$bin" \
  --target web \
  --no-typescript \
  --out-dir "$out" \
  --out-name office_wasm \
  target/wasm32-unknown-unknown/release/federwerk_office_wasm.wasm

echo "::group::Ergebnis"
ls -la "$out"

wasm="$out/office_wasm_bg.wasm"
if [ -f "$wasm" ]; then
  # Bash-Arithmetik statt awk: `print (x) > 25` ist in awk eine Umleitung und
  # damit ein Syntaxfehler.
  bytes="$(stat -c%s "$wasm")"
  mib=$(( bytes / 1048576 ))
  kib=$(( (bytes / 1024) % 1024 ))
  echo "WASM: ${mib} MiB ${kib} KiB (${bytes} Bytes)"
  echo "::endgroup::"
  # Cloudflare Workers Static Assets: 25 MiB je Datei. Darueber kann die
  # Engine nicht als Asset ausgeliefert werden - dann lieber hier abbrechen,
  # als still ein zu grosses Asset zu veroeffentlichen.
  if [ "$mib" -ge 25 ]; then
    echo "::error::WASM ist ${mib} MiB und damit groesser als das 25-MiB-Limit je Datei bei Cloudflare."
    exit 1
  fi
  echo "Groesse liegt unter dem 25-MiB-Limit."
else
  echo "::group::"
  echo "::error::office_wasm_bg.wasm fehlt nach wasm-bindgen"
  exit 1
fi

# _headers-Eintraege fuer das WASM: der richtige MIME-Typ ist Pflicht, sonst
# scheitert instantiateStreaming und der Browser faellt auf einen langsameren
# Weg zurueck.
cat > "$out/office_wasm.headers" <<'HEADERS'
/office_wasm_bg.wasm
  Content-Type: application/wasm
  Cache-Control: public, max-age=31536000, immutable

/office_wasm.js
  Cache-Control: public, max-age=31536000, immutable
HEADERS

echo "fertig: $out"