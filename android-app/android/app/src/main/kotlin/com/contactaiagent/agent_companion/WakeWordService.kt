package com.contactaiagent.agent_companion

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.media.ToneGenerator
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import org.vosk.Model
import org.vosk.Recognizer
import org.vosk.android.RecognitionListener
import org.vosk.android.SpeechService
import java.io.DataOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.zip.ZipInputStream

/**
 * "Hey <name>": listens on the phone for the wake phrase, fully offline (Vosk, a small English
 * speech model limited to that one phrase). Nothing leaves the phone until the phrase is heard.
 * Then it beeps, records the command until you stop talking, sends it to the agent as a voice note,
 * and plays the agent's spoken reply.
 */
class WakeWordService : Service(), RecognitionListener {
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var model: Model? = null
    private var speech: SpeechService? = null
    private var recorder: MediaRecorder? = null
    private var player: MediaPlayer? = null
    private var stopped = false
    private var busy = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        channel(this)
        AgentService.channels(this)
        val n = notification("Starting…")
        if (Build.VERSION.SDK_INT >= 30) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE) else startForeground(ID, n)
        running = true
        io.execute { prepare() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        stopped = true
        running = false
        speech?.shutdown()
        speech = null
        try { recorder?.release() } catch (_: Exception) {}
        player?.release()
        model?.close()
        main.removeCallbacksAndMessages(null)
        io.shutdownNow()
        setStatus("off", null)
        super.onDestroy()
    }

    private fun cfg() = config(this)

    // --- Model ---

    private fun prepare() {
        try {
            val dir = File(filesDir, MODEL_DIR)
            if (!File(dir, "am/final.mdl").exists()) downloadModel(dir)
            model = Model(dir.absolutePath)
            main.post { listen() }
        } catch (e: Exception) {
            Log.w(TAG, "prepare: ${e.message}")
            setStatus("error", "Couldn't get the listening model: ${e.message}")
            update("Couldn't start: ${e.message}")
        }
    }

    private fun downloadModel(dir: File) {
        setStatus("downloading", "0")
        update("Downloading the listening model (40 MB, once)…")
        val zip = File(cacheDir, "vosk-model.zip")
        val c = URL(MODEL_URL).openConnection() as HttpURLConnection
        c.connectTimeout = 20_000
        c.readTimeout = 60_000
        val total = c.contentLengthLong.coerceAtLeast(1)
        c.inputStream.use { input ->
            zip.outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                var done = 0L
                var last = -1
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    done += n
                    val pct = (done * 100 / total).toInt()
                    if (pct != last) { last = pct; setStatus("downloading", "$pct") }
                }
            }
        }
        // The zip has one top folder (vosk-model-small-en-us-0.15/…): unpack its contents into dir.
        val tmp = File(filesDir, "$MODEL_DIR.tmp").apply { deleteRecursively(); mkdirs() }
        ZipInputStream(zip.inputStream().buffered()).use { z ->
            while (true) {
                val e = z.nextEntry ?: break
                val rel = e.name.substringAfter('/', "")
                if (rel.isEmpty()) continue
                val f = File(tmp, rel)
                if (!f.canonicalPath.startsWith(tmp.canonicalPath)) continue
                if (e.isDirectory) f.mkdirs() else { f.parentFile?.mkdirs(); f.outputStream().use { z.copyTo(it) } }
            }
        }
        zip.delete()
        dir.deleteRecursively()
        if (!tmp.renameTo(dir)) throw IllegalStateException("couldn't unpack the model")
    }

    // --- Listening for the phrase ---

    private fun phrase(): String = "hey ${cfg().name.trim().lowercase()}"

    private fun shouldListen(): Boolean {
        if (!cfg().onlyCharging) return true
        val s = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val plugged = s?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        return plugged != 0
    }

    private fun listen() {
        if (stopped || busy) return
        val m = model ?: return
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            setStatus("error", "Allow the microphone")
            update("Allow the microphone in the app")
            return
        }
        if (!shouldListen()) {
            setStatus("paused", "Waiting for the charger")
            update("Paused until the phone is charging")
            main.postDelayed({ listen() }, 60_000)
            return
        }
        try {
            // Only the wake phrase (and "unknown") can be recognised: few false alarms, little CPU.
            val grammar = JSONArray().put(phrase()).put("[unk]").toString()
            val rec = Recognizer(m, 16000f, grammar)
            speech = SpeechService(rec, 16000f).also { it.startListening(this) }
            setStatus("listening", phrase())
            update("Listening for \"${cfg().name}\"")
        } catch (e: Exception) {
            Log.w(TAG, "listen: ${e.message}")
            setStatus("error", e.message)
            main.postDelayed({ listen() }, 10_000)
        }
    }

    private fun heard(text: String?) {
        val t = text?.let { runCatching { JSONObject(it).optString("partial", JSONObject(it).optString("text")) }.getOrNull() } ?: return
        if (busy || !t.contains(phrase())) return
        busy = true
        speech?.stop()
        speech?.shutdown()
        speech = null
        main.postDelayed({ command() }, 150)
    }

    override fun onPartialResult(hypothesis: String?) = heard(hypothesis)
    override fun onResult(hypothesis: String?) = heard(hypothesis)
    override fun onFinalResult(hypothesis: String?) = heard(hypothesis)
    override fun onError(exception: Exception?) {
        Log.w(TAG, "vosk: ${exception?.message}")
        speech?.shutdown(); speech = null
        main.postDelayed({ listen() }, 3000)
    }
    override fun onTimeout() { speech?.shutdown(); speech = null; listen() }

    // --- The command ---

    private fun command() {
        beep(ToneGenerator.TONE_PROP_BEEP)
        vibrate()
        setStatus("recording", null)
        update("I'm listening…")
        val file = File(cacheDir, "wake-${System.currentTimeMillis()}.m4a")
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(this) else @Suppress("DEPRECATION") MediaRecorder()
        try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setAudioSamplingRate(44100)
            r.setAudioChannels(1)
            r.setAudioEncodingBitRate(96000)
            r.setOutputFile(file.absolutePath)
            r.prepare()
            r.start()
        } catch (e: Exception) {
            r.release(); done("Couldn't record: ${e.message}"); return
        }
        recorder = r
        val started = System.currentTimeMillis()
        var spoke = false
        var quietSince = started
        val tick = object : Runnable {
            override fun run() {
                val level = try { r.maxAmplitude } catch (_: Exception) { 0 }
                val now = System.currentTimeMillis()
                if (level > SPEECH_LEVEL) { spoke = true; quietSince = now }
                val silentFor = now - quietSince
                val elapsed = now - started
                // Stop after a pause once you've spoken, after 6 s of nothing, or after 20 s in all.
                if ((spoke && silentFor > 1400) || (!spoke && elapsed > 6000) || elapsed > 20_000) {
                    try { r.stop() } catch (_: Exception) {}
                    r.release()
                    recorder = null
                    beep(ToneGenerator.TONE_PROP_ACK)
                    if (!spoke) { file.delete(); done(null); return }
                    val seconds = ((now - started) / 1000).toInt().coerceAtLeast(1)
                    io.execute { send(file, seconds) }
                } else main.postDelayed(this, 100)
            }
        }
        main.postDelayed(tick, 300)
    }

    private fun send(file: File, seconds: Int) {
        val c = AgentService.config(this) ?: return done("Sign in to the app first")
        setStatus("thinking", null)
        update("Thinking…")
        try {
            val before = lastMessageId(c)
            upload(c, file, seconds)
            file.delete()
            // Wait for the agent's answer (voice notes are transcribed first, so give it time).
            val end = System.currentTimeMillis() + 120_000
            while (System.currentTimeMillis() < end && !stopped) {
                Thread.sleep(2500)
                val reply = replyAfter(c, before) ?: continue
                val audio = reply.optJSONObject("meta")?.optString("audio")?.takeIf { it.isNotBlank() }
                val text = reply.optString("text")
                // The background connection already shows the agent's messages; only notify without it.
                if (!AgentService.running) notifyReply(text)
                if (cfg().speak && audio != null) play("${c.server}/api/media/${Uri.encode(audio)}", c.cookie) else done(null)
                return
            }
            done("No answer yet. It will show in the app.")
        } catch (e: Exception) {
            Log.w(TAG, "send: ${e.message}")
            done("Couldn't reach the agent: ${e.message}")
        }
    }

    private fun ownerQuery(c: AgentService.Companion.Config) = c.owner?.let { "&owner=${Uri.encode(it)}" } ?: ""

    private fun messages(c: AgentService.Companion.Config, after: Long): JSONArray? {
        val body = AgentService.request(c, "GET", "${c.server}/api/app/chat?after=$after${ownerQuery(c)}", null) ?: return null
        return JSONObject(body).optJSONArray("messages")
    }

    private fun lastMessageId(c: AgentService.Companion.Config): Long {
        val a = messages(c, 0) ?: return 0
        return if (a.length() == 0) 0 else a.getJSONObject(a.length() - 1).optLong("id")
    }

    // The first reply from the agent after our voice note (skipping "searching…" placeholders).
    private fun replyAfter(c: AgentService.Companion.Config, after: Long): JSONObject? {
        val a = messages(c, after) ?: return null
        for (i in 0 until a.length()) {
            val m = a.getJSONObject(i)
            if (m.optString("direction") == "out" && !m.optString("text").startsWith("🔎")) return m
        }
        return null
    }

    private fun upload(c: AgentService.Companion.Config, file: File, seconds: Int) {
        val boundary = "----agent${System.currentTimeMillis()}"
        val conn = URL("${c.server}/api/app/voice").openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.connectTimeout = 15_000
        conn.readTimeout = 60_000
        conn.setRequestProperty("Cookie", c.cookie)
        conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
        DataOutputStream(conn.outputStream).use { out ->
            fun field(name: String, value: String) {
                out.writeBytes("--$boundary\r\nContent-Disposition: form-data; name=\"$name\"\r\n\r\n")
                out.write(value.toByteArray()); out.writeBytes("\r\n")
            }
            if (c.owner != null) field("owner", c.owner)
            field("duration", "$seconds")
            out.writeBytes("--$boundary\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"${file.name}\"\r\nContent-Type: audio/mp4\r\n\r\n")
            file.inputStream().use { it.copyTo(out) }
            out.writeBytes("\r\n--$boundary--\r\n")
        }
        val code = conn.responseCode
        conn.disconnect()
        if (code !in 200..299) throw IllegalStateException("server said $code")
    }

    private fun play(url: String, cookie: String) {
        main.post {
            setStatus("speaking", null)
            update("Speaking…")
            val p = MediaPlayer()
            player = p
            try {
                p.setDataSource(this, Uri.parse(url), mapOf("Cookie" to cookie))
                p.setOnPreparedListener { it.start() }
                p.setOnCompletionListener { it.release(); player = null; done(null) }
                p.setOnErrorListener { mp, _, _ -> mp.release(); player = null; done(null); true }
                p.prepareAsync()
            } catch (e: Exception) {
                p.release(); player = null; done(null)
            }
        }
    }

    private fun done(error: String?) {
        main.post {
            if (error != null) notifyReply(error)
            busy = false
            listen()
        }
    }

    private fun notifyReply(text: String) {
        if (text.isBlank()) return
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val n = NotificationCompat.Builder(this, AGENT_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_agent)
            .setContentTitle(cfg().name)
            .setContentText(text.lineSequence().first().take(120))
            .setStyle(NotificationCompat.BigTextStyle().bigText(text.take(1200)))
            .setAutoCancel(true)
            .setContentIntent(AgentService.openApp(this, null))
            .build()
        getSystemService(NotificationManager::class.java).notify(ID_REPLY, n)
    }

    private fun beep(tone: Int) = try {
        ToneGenerator(AudioManager.STREAM_NOTIFICATION, 70).apply { startTone(tone, 150); main.postDelayed({ release() }, 400) }
        Unit
    } catch (_: Exception) {}

    private fun vibrate() = try {
        getSystemService(Vibrator::class.java)?.vibrate(VibrationEffect.createOneShot(60, VibrationEffect.DEFAULT_AMPLITUDE))
        Unit
    } catch (_: Exception) {}

    private fun notification(text: String): Notification =
        NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_agent)
            .setContentTitle("Hey ${config(this).name}")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(AgentService.openApp(this, null))
            .build()

    private fun update(text: String) {
        if (stopped) return
        getSystemService(NotificationManager::class.java).notify(ID, notification(text))
    }

    private fun setStatus(state: String, detail: String?) {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("state", state).putString("detail", detail).apply()
    }

    companion object {
        private const val TAG = "WakeWord"
        private const val CHANNEL = "agent_wake"
        private const val AGENT_CHANNEL = "agent_messages"
        private const val ID = 5
        private const val ID_REPLY = 6
        private const val PREFS = "agent_wake"
        private const val MODEL_DIR = "vosk-en"
        private const val MODEL_URL = "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip"
        private const val SPEECH_LEVEL = 2500

        @Volatile var running = false

        data class WakeConfig(val name: String, val speak: Boolean, val onlyCharging: Boolean)

        fun configure(ctx: Context, enabled: Boolean, name: String, speak: Boolean, onlyCharging: Boolean) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean("enabled", enabled).putString("name", name.ifBlank { "Jarvis" })
                .putBoolean("speak", speak).putBoolean("onlyCharging", onlyCharging).apply()
        }

        fun config(ctx: Context): WakeConfig {
            val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return WakeConfig(p.getString("name", "Jarvis") ?: "Jarvis", p.getBoolean("speak", true), p.getBoolean("onlyCharging", false))
        }

        fun enabled(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", false)

        fun status(ctx: Context): Map<String, Any?> {
            val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return mapOf("running" to running, "state" to (if (running) p.getString("state", "starting") else "off"), "detail" to p.getString("detail", null))
        }

        fun start(ctx: Context) {
            ctx.stopService(Intent(ctx, WakeWordService::class.java))
            ctx.startForegroundService(Intent(ctx, WakeWordService::class.java))
        }

        fun stop(ctx: Context) = ctx.stopService(Intent(ctx, WakeWordService::class.java))

        fun channel(ctx: Context) {
            ctx.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "Wake word", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown while the app listens for \"Hey …\" on this phone"
                },
            )
        }
    }
}
