#!/usr/bin/env bash
# Baut das Craft-WASM (PSD/SVG/IDML-Bridge) und die wasm-bindgen-Glue.
#
# Aufruf: craft-wasm/build.sh [Ausgabeordner]
# Default: craft-wasm/dist/ -> wird von scripts/build.js nach dist/ kopiert.
#
# Bewusst getrennt von office-wasm/build.sh: die Office-Engine und die
# Grafik-Engine werden rarely nicht gleichzeitig gebraucht, und als getrennte
# WASM bleibt jede Datei klein genug fuer das 25-MiB-Limit und laesst sich
# einzeln nachladen. Die Plattform-Erkennung ist trotzdem dieselbe.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-$here/dist}"

cd "$here"

echo "::group::Rust"
rustc --version
cargo --version

echo "::group::Ziel wasm32-unknown-unknown nachinstallieren"
rustup target add wasm32-unknown-unknown

# WASM-Binary passend zum Runner holen (OS *und* Architektur - auf
# windows-latest scheitert ein Linux-musl-Binary mit Exec format error).
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
          bin=wasm-bindgen.exe ;;
  *) echo "::error::Runner-Plattform nicht unterstuetzt: $os_name/$machine"; exit 1 ;;
esac
echo "Runner: ${os_name}/${machine} -> ${wa}"

wb_version="$(grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | grep '^version' | head -1 | sed -E 's/.*"([^"]+)".*/\1/')"
if [ -z "$wb_version" ]; then
  echo "::error::wasm-bindgen-Version nicht in Cargo.lock gefunden (Cargo.lock fehlt? einmal 'cargo fetch' laufen lassen)"
  exit 1
fi
echo "wasm-bindgen-Crate: ${wb_version}"

cli_dir="$here/.tooling"
mkdir -p "$cli_dir"
if [ ! -x "$cli_dir/$bin" ]; then
  echo "::group::wasm-bindgen ${wb_version} fuer ${wa}"
  url="https://github.com/rustwasm/wasm-bindgen/releases/download/${wb_version}/wasm-bindgen-${wb_version}-${wa}.tar.gz"
  curl -fsSL "$url" | tar -xz -C "$cli_dir" --strip-components=1
  chmod +x "$cli_dir/$bin" 2>/dev/null || true
fi
if ! "$cli_dir/$bin" --version >/dev/null 2>&1; then
  echo "::error::wasm-bindgen aus $cli_dir laesst sich hier nicht ausfuehren (falsche Plattform?)."
  exit 1
fi
"$cli_dir/$bin" --version

echo "::group::cargo build --release --target wasm32-unknown-unknown"
cargo build --release --target wasm32-unknown-unknown --lib

echo "::group::wasm-bindgen"
rm -rf "$out"
mkdir -p "$out"
"$cli_dir/$bin" \
  --target web \
  --no-typescript \
  --out-dir "$out" \
  --out-name craft_wasm \
  target/wasm32-unknown-unknown/release/federwerk_craft_wasm.wasm

wasm="$out/craft_wasm_bg.wasm"
if [ ! -f "$wasm" ]; then
  echo "::error::craft_wasm_bg.wasm fehlt nach wasm-bindgen"
  exit 1
fi
bytes="$(stat -c%s "$wasm")"
mib=$(( bytes / 1048576 ))
kib=$(( (bytes / 1024) % 1024 ))
echo "WASM: ${mib} MiB ${kib} KiB (${bytes} Bytes)"
if [ "$mib" -ge 25 ]; then
  echo "::error::Craft-WASM ist ${mib} MiB und damit groesser als das 25-MiB-Limit je Datei bei Cloudflare."
  exit 1
fi
echo "Groesse liegt unter dem 25-MiB-Limit."

cat > "$out/craft_wasm.headers" <<'HEADERS'
/craft_wasm_bg.wasm
  Content-Type: application/wasm
  Cache-Control: public, max-age=31536000, immutable

/craft_wasm.js
  Cache-Control: public, max-age=31536000, immutable
HEADERS

echo "fertig: $out"