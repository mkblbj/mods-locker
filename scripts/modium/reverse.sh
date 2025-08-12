#!/usr/bin/env bash
set -euo pipefail

INPUT=${1:?"Usage: reverse.sh <installer|app.asar|installed_app_dir>"}
ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")"/../../ && pwd)
WORKDIR="$ROOT_DIR/reverse/modium"
EXTRACTED="$WORKDIR/extracted"
UNPACKED="$WORKDIR/unpacked"
STATE="$WORKDIR/target.txt"

mkdir -p "$WORKDIR"
echo "[+] Workspace: $WORKDIR"

command -v innoextract >/dev/null 2>&1 || echo "[!] innoextract not found; will fallback to 7z"
command -v 7z >/dev/null 2>&1 || { echo "[!] 7z not found. apt-get install p7zip-full"; }

ASAR_PATH=""

if [[ -f "$INPUT" && "${INPUT##*.}" == "asar" ]]; then
  echo "[i] Input is an asar file: $INPUT"
  ASAR_PATH="$INPUT"
elif [[ -d "$INPUT" ]]; then
  echo "[i] Input is an installed app directory: $INPUT"
  ASAR_PATH=$(find "$INPUT" -maxdepth 6 -type f -name app.asar | head -n1 || true)
else
  echo "[i] Input looks like an installer: $INPUT"
  rm -rf "$EXTRACTED" && mkdir -p "$EXTRACTED"
  set +e
  innoextract -e "$INPUT" -d "$EXTRACTED" >/dev/null 2>&1
  INNO=$?
  set -e
  if [[ $INNO -ne 0 ]]; then
    echo "[i] Not InnoSetup or failed; trying 7z..."
    7z x "$INPUT" -o"$EXTRACTED" -y | cat >/dev/null || true
  fi
  echo "[+] Searching for app.asar ..."
  ASAR_PATH=$(find "$EXTRACTED" -type f -name app.asar | head -n1 || true)
fi
rm -rf "$UNPACKED" && mkdir -p "$UNPACKED"

if [[ -n "${ASAR_PATH}" ]]; then
  echo "ASAR $ASAR_PATH" > "$STATE"
  echo "[+] Found asar: $ASAR_PATH"
  node -e "import asar from 'asar'; asar.extractAll(process.argv[1], process.argv[2])" "$ASAR_PATH" "$UNPACKED"
  echo "[+] Extracted to: $UNPACKED"
else
  if [[ -d "$INPUT" ]]; then
    echo "DIR $INPUT" > "$STATE"
    if command -v rsync >/dev/null 2>&1; then
      rsync -a "$INPUT/" "$UNPACKED/"
    else
      cp -a "$INPUT/." "$UNPACKED/"
    fi
    echo "[i] No app.asar found. Copied directory as unpacked app -> $UNPACKED"
  else
    echo "[!] app.asar not found and input is not a directory. Aborting."
    exit 2
  fi
fi

echo "[+] Prettifying JS files..."
node -e 'import fg from "fast-glob"; (async()=>{const files=await fg(["**/*.js","**/*.cjs","**/*.mjs"],{cwd:process.argv[2],dot:true,absolute:true}); if(files.length===0){ console.log("[i] no js files to format"); process.exit(0);} const {spawn}=await import("node:child_process"); const p=spawn("npx",["prettier","--write",...files],{stdio:"inherit"}); p.on("exit",c=>process.exit(c));})();' dummy "$UNPACKED"

echo "[+] URLs in code -> $WORKDIR/urls.txt"
rg -n "https?://[^\"'\) ]+" "$UNPACKED" | tee "$WORKDIR/urls.txt" || true

echo "[✓] reverse done"

