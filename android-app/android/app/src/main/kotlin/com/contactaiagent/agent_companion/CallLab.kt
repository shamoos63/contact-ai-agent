package com.contactaiagent.agent_companion

import android.Manifest
import android.app.role.RoleManager
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import java.util.concurrent.TimeUnit

/**
 * Checks what this phone allows for AI phone calls later. Normal apps can't hear or speak into a
 * SIM call since Android 10; with root the app can be made a privileged system app, which may allow
 * it. These checks tell us which path will work on this phone.
 */
object CallLab {
    private fun item(name: String, status: String, detail: String) = mapOf("name" to name, "status" to status, "detail" to detail)

    fun run(ctx: Context): List<Map<String, String>> {
        val out = mutableListOf<Map<String, String>>()
        out += item(
            "Phone",
            "ok",
            "${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT}) · ${Build.DISPLAY}",
        )

        val (rootOk, rootOut) = su("id")
        out += if (rootOk && rootOut.contains("uid=0")) item("Root", "ok", "su works: ${rootOut.trim().take(80)}")
        else item("Root", "fail", if (rootOut.isBlank()) "No root access (su missing or denied). Grant root to this app in Magisk." else rootOut.trim().take(160))

        if (rootOk) {
            val (_, magisk) = su("magisk -v 2>/dev/null; magisk -V 2>/dev/null")
            out += item("Magisk", if (magisk.isNotBlank()) "ok" else "warn", if (magisk.isNotBlank()) magisk.trim().replace("\n", " · ") else "Not found (another root method?)")
            val (_, priv) = su("ls -d /system/priv-app 2>/dev/null && getprop ro.build.system_root_image; getenforce")
            out += item("System / SELinux", "warn", priv.trim().replace("\n", " · ").ifBlank { "unknown" })
        }

        val phonePerms = listOf(Manifest.permission.READ_PHONE_STATE, Manifest.permission.READ_CALL_LOG)
            .all { ctx.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
        out += item("Call state and call log", if (phonePerms) "ok" else "fail", if (phonePerms) "Allowed: missed calls and call notes work" else "Not allowed yet: allow Phone and Call log")

        if (Build.VERSION.SDK_INT >= 29) {
            val rm = ctx.getSystemService(RoleManager::class.java)
            val dialer = rm?.isRoleHeld(RoleManager.ROLE_DIALER) == true
            val screening = rm?.isRoleHeld(RoleManager.ROLE_CALL_SCREENING) == true
            out += item("Phone app role", if (dialer || screening) "ok" else "warn",
                "Default phone app: ${if (dialer) "yes" else "no"} · Call screening: ${if (screening) "yes" else "no"} (needed later to answer calls automatically)")
        }

        val capture = ctx.checkSelfPermission("android.permission.CAPTURE_AUDIO_OUTPUT") == PackageManager.PERMISSION_GRANTED
        out += item("Privileged audio permission", if (capture) "ok" else "warn",
            if (capture) "CAPTURE_AUDIO_OUTPUT granted: the app can hear calls"
            else "Not granted. With root, install the app as a privileged system app (Magisk module) to get it.")

        val micOk = ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (!micOk) {
            out += item("Call audio sources", "fail", "Allow the microphone first, then run again")
        } else {
            for ((name, src) in listOf(
                "Hear both sides (VOICE_CALL)" to MediaRecorder.AudioSource.VOICE_CALL,
                "Hear the caller (VOICE_DOWNLINK)" to MediaRecorder.AudioSource.VOICE_DOWNLINK,
                "Hear our side (VOICE_UPLINK)" to MediaRecorder.AudioSource.VOICE_UPLINK,
            )) {
                out += item(name, if (canOpen(src)) "ok" else "fail",
                    if (canOpen(src)) "The app can open this source (test it during a real call)" else "Blocked for this app")
            }
        }
        out += item("Speak into a call", "warn", "Can only be tested during a live call; it depends on the chip (Snapdragon 855) and the ROM. Next step after root and privileged install.")
        return out
    }

    private fun canOpen(source: Int): Boolean {
        val rate = 16000
        val size = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT).coerceAtLeast(4096)
        return try {
            @Suppress("MissingPermission")
            val r = AudioRecord(source, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, size)
            val ok = r.state == AudioRecord.STATE_INITIALIZED
            r.release()
            ok
        } catch (e: Exception) {
            false
        }
    }

    /** Runs a command as root. Returns (worked, output). Magisk shows a grant prompt the first time. */
    private fun su(cmd: String): Pair<Boolean, String> = try {
        val p = ProcessBuilder("su", "-c", cmd).redirectErrorStream(true).start()
        val finished = p.waitFor(15, TimeUnit.SECONDS)
        val text = p.inputStream.bufferedReader().readText()
        if (!finished) { p.destroy(); false to "su did not answer (grant root to this app in Magisk)" }
        else (p.exitValue() == 0) to text
    } catch (e: Exception) {
        false to ""
    }
}
