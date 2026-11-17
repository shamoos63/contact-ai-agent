# Agent companion (Android)

Your AI agent in your pocket. The app connects to the Contact AI Agent dashboard running on your computer.

- **Agent**: talk to the assistant by typing, by voice (tap the orb or the mic), or with a photo. It's the same chat as your WhatsApp messages to the assistant, so reminders, drafts, alerts and questions all work the same. Drafts get one-tap **Yes / No** buttons, and spoken replies play automatically after you send a voice note.
- **Inbox**: every customer chat from every channel. Answer yourself, let the AI answer, or switch the AI off for a chat.
- **Calls** (on the business phone):
  - **Missed call → WhatsApp**: when nobody answers, the agent messages the caller right away. It's off until you switch it on, and each caller gets at most one message per 12 hours.
  - **Call notes**: after a call, a notification asks what it was about. The note goes to that customer's chat and memory.
  - **Call lab**: checks root, privileged audio and call audio sources. These decide which way AI phone calls can work later on this phone.
- **Notifications**: urgent customers (🚨), questions the agent can't answer (❓) and drafts waiting for your "yes" pop up on the phone.

## Install

1. Build: `cd android-app && flutter build apk --release`, or use the APK from `build/app/outputs/flutter-apk/app-release.apk`.
2. Install: `adb install -r build/app/outputs/flutter-apk/app-release.apk`, or copy the APK to the phone and open it.
3. Open **Agent** and enter the computer's address on your Wi-Fi, e.g. `http://192.168.1.20:3000`. Find it on the Mac under System Settings → Wi-Fi → Details → IP address. Sign in with the dashboard username and password.
4. In the dashboard, the **Assistant** must be on, with your WhatsApp number as an owner.

The phone and the computer must be on the same network. To use the app away from the office, give the dashboard a public HTTPS address (for example a named Cloudflare Tunnel) and use that address in the app.

## Notes

- Built with Flutter. Recording, playback, photos, notifications and calls are small native Kotlin pieces in `android/app/src/main/kotlin`, so the app needs no extra plugins.
- The background connection checks for new agent messages every 15 seconds. On Xiaomi phones, allow **Autostart** and set battery saver to **No restrictions** for Agent, or MIUI/HyperOS may stop it.
- Talking to the agent needs no extra server setup. The server part is `server/src/routes/device.js` (`/api/app/*`).
