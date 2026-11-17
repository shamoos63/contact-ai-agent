# Magisk module: Agent companion as a privileged app

Puts the app in `/system/priv-app/AgentCompanion/` (systemless, through Magisk) and whitelists
`CAPTURE_AUDIO_OUTPUT`, which lets it hear call audio for AI phone calls. The normal app install
stays as an update of this system copy, so sign-in and settings are kept.

Build: `tool/build-magisk-module.sh` (after `flutter build apk --release`).
Install: `adb push agent-companion-privapp.zip /sdcard/ && adb shell su -c 'magisk --install-module /sdcard/agent-companion-privapp.zip'`, then reboot.
Undo: disable or remove "Agent companion: privileged app" in Magisk and reboot.
