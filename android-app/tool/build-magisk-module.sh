#!/bin/sh
# Packs the release APK into the Magisk module zip (android-app/build/agent-companion-privapp.zip).
set -e
cd "$(dirname "$0")/.."
OUT=build/magisk
rm -rf "$OUT" && mkdir -p "$OUT/system/priv-app/AgentCompanion"
cp -R tool/magisk-module/. "$OUT/"
rm -f "$OUT/README.md"
cp build/app/outputs/flutter-apk/app-release.apk "$OUT/system/priv-app/AgentCompanion/AgentCompanion.apk"
(cd "$OUT" && rm -f ../agent-companion-privapp.zip && zip -qr ../agent-companion-privapp.zip .)
echo "build/agent-companion-privapp.zip"
