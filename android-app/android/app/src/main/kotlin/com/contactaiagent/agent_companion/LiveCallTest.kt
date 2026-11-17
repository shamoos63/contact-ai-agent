package com.contactaiagent.agent_companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.util.Log
import java.io.File
import kotlin.concurrent.thread
import kotlin.math.PI
import kotlin.math.log10
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Run during a real SIM call to learn what this phone allows for AI calls:
 * (a) hearing: record 5 s from each call-audio source and measure the level (silence = blocked);
 * (b) speaking: play four tone patterns through different routes; the person on the other phone
 *     says which ones they heard (A = 1 beep, B = 2 beeps, C = 3 beeps, D = one long tone).
 * Results go to the screen and to logcat (tag CallLab).
 */
object LiveCallTest {
    private const val TAG = "CallLab"
    private const val RATE = 16000

    fun run(ctx: Context, progress: (String) -> Unit = {}): List<Map<String, String>> {
        val out = mutableListOf<Map<String, String>>()
        fun add(name: String, status: String, detail: String) {
            out += mapOf("name" to name, "status" to status, "detail" to detail)
            Log.i(TAG, "$name [$status] $detail")
        }
        val am = ctx.getSystemService(AudioManager::class.java)
        add("Call state", if (am.mode == AudioManager.MODE_IN_CALL || am.mode == AudioManager.MODE_IN_COMMUNICATION) "ok" else "warn",
            "Audio mode ${am.mode} (2 = in a phone call). Run this while a call is active.")

        for ((name, src) in listOf(
            "Hear the caller (VOICE_DOWNLINK)" to MediaRecorder.AudioSource.VOICE_DOWNLINK,
            "Hear both sides (VOICE_CALL)" to MediaRecorder.AudioSource.VOICE_CALL,
            "Hear our side (VOICE_UPLINK)" to MediaRecorder.AudioSource.VOICE_UPLINK,
        )) {
            progress("Listening: $name (5 s)…")
            val (db, file) = record(ctx, src, name.substringAfter('(').trimEnd(')').lowercase())
            when {
                db == null -> add(name, "fail", "Couldn't open this source")
                db < -70 -> add(name, "fail", "Opened, but only silence (${"%.0f".format(db)} dBFS)")
                else -> add(name, "ok", "Real audio: ${"%.0f".format(db)} dBFS. Saved ${file?.name}")
            }
        }

        // Speaking into the call. Each variant has its own tone pattern so the caller can tell them apart.
        am.setParameters("incall_music_enabled=true")
        val variants = listOf(
            Triple("A (1 beep): voice-communication usage", AudioAttributes.USAGE_VOICE_COMMUNICATION, 1),
            Triple("B (2 beeps): media usage (in-call music path)", AudioAttributes.USAGE_MEDIA, 2),
            Triple("C (3 beeps): media usage, mode set to in-call", AudioAttributes.USAGE_MEDIA, 3),
            Triple("D (long tone): voice-communication, mode set to in-call", AudioAttributes.USAGE_VOICE_COMMUNICATION, 0),
        )
        for ((label, usage, beeps) in variants) {
            progress("Speaking: $label…")
            val previousMode = am.mode
            if (label.startsWith("C") || label.startsWith("D")) try { am.mode = AudioManager.MODE_IN_CALL } catch (e: Exception) { Log.w(TAG, "mode: ${e.message}") }
            val result = try { play(usage, beeps); "Played. Did the other phone hear it?" } catch (e: Exception) { "Failed: ${e.message}" }
            if (am.mode != previousMode) try { am.mode = previousMode } catch (_: Exception) {}
            add("Speak $label", if (result.startsWith("Played")) "warn" else "fail", result)
            Thread.sleep(800)
        }
        am.setParameters("incall_music_enabled=false")
        return out
    }

    /** Records 5 s; returns the RMS level in dBFS (or null if the source can't be opened) and the WAV file. */
    private fun record(ctx: Context, source: Int, tag: String): Pair<Double?, File?> {
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT).coerceAtLeast(4096)
        val rec = try {
            @Suppress("MissingPermission")
            AudioRecord(source, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, min * 2)
        } catch (e: Exception) { return null to null }
        if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); return null to null }
        val samples = ShortArray(RATE * 5)
        try {
            rec.startRecording()
            var read = 0
            while (read < samples.size) {
                val n = rec.read(samples, read, minOf(2048, samples.size - read))
                if (n <= 0) break
                read += n
            }
        } catch (e: Exception) {
            rec.release(); return null to null
        }
        rec.stop(); rec.release()
        var sum = 0.0
        for (s in samples) sum += s.toDouble() * s
        val rms = sqrt(sum / samples.size)
        val db = if (rms < 1) -96.0 else 20 * log10(rms / 32768.0)
        val file = File(ctx.getExternalFilesDir(null) ?: ctx.filesDir, "calltest-$tag-${System.currentTimeMillis()}.wav")
        writeWav(file, samples)
        return db to file
    }

    private fun play(usage: Int, beeps: Int) {
        val pcm = tones(beeps)
        val track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(usage).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(AudioFormat.Builder().setSampleRate(RATE).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setBufferSizeInBytes(pcm.size * 2)
            .setTransferMode(AudioTrack.MODE_STATIC)
            .build()
        track.write(pcm, 0, pcm.size)
        track.play()
        Thread.sleep(pcm.size * 1000L / RATE + 200)
        track.stop(); track.release()
    }

    // 1-3 short beeps (0.35 s each, 880 Hz) or, for 0, one 2.5 s tone (660 Hz).
    private fun tones(beeps: Int): ShortArray {
        val parts = mutableListOf<ShortArray>()
        fun tone(seconds: Double, hz: Double) = ShortArray((RATE * seconds).toInt()) { i -> (sin(2 * PI * hz * i / RATE) * 0.6 * Short.MAX_VALUE).toInt().toShort() }
        fun gap(seconds: Double) = ShortArray((RATE * seconds).toInt())
        if (beeps == 0) parts += tone(2.5, 660.0) else repeat(beeps) { parts += tone(0.35, 880.0); parts += gap(0.3) }
        return parts.flatMap { it.asList() }.toShortArray()
    }

    private fun writeWav(f: File, s: ShortArray) {
        val data = ByteArray(s.size * 2)
        for (i in s.indices) { data[i * 2] = (s[i].toInt() and 0xff).toByte(); data[i * 2 + 1] = (s[i].toInt() shr 8 and 0xff).toByte() }
        f.outputStream().use { o ->
            fun i32(v: Int) = o.write(byteArrayOf((v and 0xff).toByte(), (v shr 8 and 0xff).toByte(), (v shr 16 and 0xff).toByte(), (v shr 24 and 0xff).toByte()))
            fun i16(v: Int) = o.write(byteArrayOf((v and 0xff).toByte(), (v shr 8 and 0xff).toByte()))
            o.write("RIFF".toByteArray()); i32(36 + data.size); o.write("WAVEfmt ".toByteArray())
            i32(16); i16(1); i16(1); i32(RATE); i32(RATE * 2); i16(2); i16(16)
            o.write("data".toByteArray()); i32(data.size); o.write(data)
        }
    }
}

/** Lets the test be started over USB as root during a call: am broadcast -n <pkg>/.LiveCallTestReceiver */
class LiveCallTestReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        thread {
            try { LiveCallTest.run(context.applicationContext) } finally { pending.finish() }
        }
    }
}
