#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")"/../../ && pwd)
WORKDIR="$ROOT_DIR/reverse/modium"
UNPACKED="$WORKDIR/unpacked"
STATE="$WORKDIR/target.txt"

if [[ ! -f "$STATE" ]]; then
  echo "[!] Missing $STATE; run make reverse INSTALLER=... first"
  exit 1
fi
TARGET_TYPE=$(awk '{print $1}' "$STATE")
TARGET_PATH=$(awk '{print $2}' "$STATE")
[[ -d "$UNPACKED" ]] || { echo "[!] No unpacked dir: $UNPACKED"; exit 1; }

if [[ "$TARGET_TYPE" == "ASAR" ]]; then
  TMP_ASAR="$WORKDIR/app.asar"
  echo "[+] Repacking from $UNPACKED -> $TMP_ASAR"
  node -e "import asar from 'asar'; asar.createPackage(process.argv[1], process.argv[2]).then(()=>process.exit(0))" "$UNPACKED" "$TMP_ASAR"
  echo "[+] Backing up original asar to $TARGET_PATH.bak"
  cp -f "$TARGET_PATH" "$TARGET_PATH.bak"
  echo "[+] Replacing $TARGET_PATH"
  cp -f "$TMP_ASAR" "$TARGET_PATH"
  echo "[✓] repack done (asar)"
elif [[ "$TARGET_TYPE" == "DIR" ]]; then
  echo "[+] No app.asar; syncing modified files back to $TARGET_PATH"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a "$UNPACKED/" "$TARGET_PATH/"
  else
    cp -a "$UNPACKED/." "$TARGET_PATH/"
  fi
  echo "[✓] sync done (dir)"
else
  echo "[!] Unknown target type in $STATE"
  exit 2
fi

