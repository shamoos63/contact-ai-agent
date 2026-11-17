package com.contactaiagent.agent_companion

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.CallLog
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Runs in the background while the owner wants it: shows the agent's alerts, questions and drafts as
 * notifications, reports missed calls (so the agent can WhatsApp the caller), and after a call asks
 * "what was it about?".
 */
class AgentService : Service() {
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var lastId: Long = -1
    private var telephonyCallback: Any? = null
    private var stopped = false

    // Call state: RINGING then IDLE without OFFHOOK is a missed call; OFFHOOK then IDLE is a finished call.
    private var ringing = false
    private var answered = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        channels(this)
        val n = NotificationCompat.Builder(this, CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_stat_agent)
            .setContentTitle("Agent is connected")
            .setContentText("Alerts and questions from your agent will show here")
            .setOngoing(true)
            .setContentIntent(openApp(this, null))
            .build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(ID_SERVICE, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(ID_SERVICE, n)
        running = true
        listenToCalls()
        main.post(poll)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        stopped = true
        running = false
        main.removeCallbacksAndMessages(null)
        stopListeningToCalls()
        io.shutdownNow()
        super.onDestroy()
    }

    private val poll = object : Runnable {
        override fun run() {
            if (stopped) return
            io.execute { checkFeed() }
            main.postDelayed(this, POLL_MS)
        }
    }

    private fun checkFeed() {
        val cfg = config(this) ?: return
        try {
            val url = if (lastId < 0) "${cfg.server}/api/app/feed" else "${cfg.server}/api/app/feed?after=$lastId"
            val body = request(cfg, "GET", url, null) ?: return
            val json = JSONObject(body)
            val messages = json.optJSONArray("messages")
            if (messages != null) {
                for (i in 0 until messages.length()) {
                    val m = messages.getJSONObject(i)
                    notifyMessage(m.optLong("id"), m.optString("text"))
                }
            }
            lastId = json.optLong("last", lastId)
        } catch (e: Exception) {
            Log.w(TAG, "feed: ${e.message}")
        }
    }

    private fun notifyMessage(id: Long, text: String) {
        if (text.isBlank()) return
        val urgent = text.startsWith("🚨")
        val question = text.startsWith("❓") || text.contains("\"yes\"") || text.contains("\"نعم\"")
        val title = when {
            urgent -> "Urgent from your agent"
            question -> "Your agent needs you"
            else -> "Agent"
        }
        val n = NotificationCompat.Builder(this, if (urgent || question) CHANNEL_ALERTS else CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_agent)
            .setContentTitle(title)
            .setContentText(text.lineSequence().first().take(120))
            .setStyle(NotificationCompat.BigTextStyle().bigText(text.take(1200)))
            .setPriority(if (urgent || question) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(if (urgent) NotificationCompat.CATEGORY_ALARM else NotificationCompat.CATEGORY_MESSAGE)
            .setColor(0xFF8B5CF6.toInt())
            .setAutoCancel(true)
            .setContentIntent(if (question) openApprovals(this) else openApp(this, null))
            .build()
        notify(this, (id % 100000).toInt() + 1000, n)
    }

    // --- Calls ---

    private fun canReadCalls() =
        checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED &&
            checkSelfPermission(Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED

    private fun listenToCalls() {
        val cfg = config(this) ?: return
        if (!(cfg.missedCalls || cfg.callNotes) || !canReadCalls()) return
        val tm = getSystemService(TelephonyManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= 31) {
            val cb = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
                override fun onCallStateChanged(state: Int) = onCallState(state)
            }
            tm.registerTelephonyCallback(mainExecutor, cb)
            telephonyCallback = cb
        } else {
            @Suppress("DEPRECATION")
            val l = object : PhoneStateListener() {
                @Deprecated("Deprecated in Java")
                override fun onCallStateChanged(state: Int, phoneNumber: String?) = onCallState(state)
            }
            @Suppress("DEPRECATION")
            tm.listen(l, PhoneStateListener.LISTEN_CALL_STATE)
            telephonyCallback = l
        }
    }

    private fun stopListeningToCalls() {
        val tm = getSystemService(TelephonyManager::class.java) ?: return
        val cb = telephonyCallback ?: return
        if (Build.VERSION.SDK_INT >= 31 && cb is TelephonyCallback) tm.unregisterTelephonyCallback(cb)
        else @Suppress("DEPRECATION") tm.listen(cb as PhoneStateListener, PhoneStateListener.LISTEN_NONE)
        telephonyCallback = null
    }

    private fun onCallState(state: Int) {
        when (state) {
            TelephonyManager.CALL_STATE_RINGING -> { ringing = true; answered = false }
            TelephonyManager.CALL_STATE_OFFHOOK -> { if (ringing) answered = true; if (!ringing) answered = true }
            TelephonyManager.CALL_STATE_IDLE -> {
                val wasMissed = ringing && !answered
                val wasCall = answered
                ringing = false
                answered = false
                // The call log is written a moment after the call ends.
                main.postDelayed({ io.execute { afterCall(wasMissed, wasCall) } }, 2500)
            }
        }
    }

    private fun afterCall(missed: Boolean, finished: Boolean) {
        val cfg = config(this) ?: return
        val last = lastCall() ?: return
        if (System.currentTimeMillis() - last.date > 5 * 60_000) return
        if (missed && cfg.missedCalls && last.missed) {
            val number = last.number ?: return
            try {
                val body = JSONObject().put("number", number)
                if (last.name != null) body.put("name", last.name)
                request(cfg, "POST", "${cfg.server}/api/app/missed-call", body.toString())
            } catch (e: Exception) {
                Log.w(TAG, "missed-call: ${e.message}")
            }
        }
        if (finished && cfg.callNotes && !last.missed && last.number != null) {
            val who = last.name ?: last.number
            val n = NotificationCompat.Builder(this, CHANNEL_MESSAGES)
                .setSmallIcon(R.drawable.ic_stat_agent)
                .setContentTitle("What was the call with $who about?")
                .setContentText("Tap to add a short note. Your agent will remember it.")
                .setAutoCancel(true)
                .setContentIntent(openApp(this, last.number))
                .build()
            notify(this, ID_CALL_NOTE, n)
        }
    }

    private data class LastCall(val number: String?, val name: String?, val missed: Boolean, val date: Long)

    private fun lastCall(): LastCall? {
        if (!canReadCalls()) return null
        return contentResolver.query(
            CallLog.Calls.CONTENT_URI,
            arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME, CallLog.Calls.TYPE, CallLog.Calls.DATE),
            null, null, "${CallLog.Calls.DATE} DESC",
        )?.use { c ->
            if (!c.moveToFirst()) null
            else LastCall(c.getString(0), c.getString(1), c.getInt(2) == CallLog.Calls.MISSED_TYPE || c.getInt(2) == CallLog.Calls.REJECTED_TYPE, c.getLong(3))
        }
    }

    companion object {
        private const val TAG = "AgentService"
        const val EXTRA_CALL_NOTE = "call_note_number"
        const val EXTRA_OPEN = "open_screen"
        private const val CHANNEL_SERVICE = "agent_service"
        private const val CHANNEL_ALERTS = "agent_alerts"
        private const val CHANNEL_MESSAGES = "agent_messages"
        private const val ID_SERVICE = 1
        private const val ID_CALL_NOTE = 2
        private const val POLL_MS = 15_000L
        private const val PREFS = "agent_service"

        @Volatile var running = false

        data class Config(val server: String, val cookie: String, val owner: String?, val missedCalls: Boolean, val callNotes: Boolean)

        fun configure(ctx: Context, server: String, cookie: String, owner: String?, missedCalls: Boolean, callNotes: Boolean) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("server", server).putString("cookie", cookie).putString("owner", owner)
                .putBoolean("missedCalls", missedCalls).putBoolean("callNotes", callNotes).putBoolean("enabled", true)
                .apply()
        }

        fun config(ctx: Context): Config? {
            val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val server = p.getString("server", null) ?: return null
            val cookie = p.getString("cookie", null) ?: return null
            return Config(server, cookie, p.getString("owner", null), p.getBoolean("missedCalls", false), p.getBoolean("callNotes", false))
        }

        fun enabled(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", false)

        fun start(ctx: Context) {
            // Restart so new settings (missed calls, notes) take effect.
            ctx.stopService(Intent(ctx, AgentService::class.java))
            ctx.startForegroundService(Intent(ctx, AgentService::class.java))
        }

        fun stop(ctx: Context) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("enabled", false).apply()
            ctx.stopService(Intent(ctx, AgentService::class.java))
        }

        fun request(cfg: Config, method: String, url: String, body: String?): String? {
            val c = URL(url).openConnection() as HttpURLConnection
            c.requestMethod = method
            c.connectTimeout = 10_000
            c.readTimeout = 20_000
            c.setRequestProperty("Cookie", cfg.cookie)
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(body.toByteArray()) }
            }
            return try {
                if (c.responseCode !in 200..299) null else c.inputStream.bufferedReader().use { it.readText() }
            } finally {
                c.disconnect()
            }
        }

        fun channels(ctx: Context) {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CHANNEL_SERVICE, "Connection", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Shown while the app keeps you connected to your agent"
            })
            nm.createNotificationChannel(NotificationChannel(CHANNEL_ALERTS, "Alerts and questions", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Urgent customers, questions the agent can't answer, drafts waiting for your yes"
            })
            nm.createNotificationChannel(NotificationChannel(CHANNEL_MESSAGES, "Agent messages", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Reminders, summaries and other messages from your agent"
            })
        }

        /** Opens the app on the Approvals screen. */
        fun openApprovals(ctx: Context): PendingIntent {
            val i = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(EXTRA_OPEN, "approvals")
            return PendingIntent.getActivity(ctx, 3, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }

        fun openApp(ctx: Context, callNoteNumber: String?): PendingIntent {
            val i = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            if (callNoteNumber != null) i.putExtra(EXTRA_CALL_NOTE, callNoteNumber)
            return PendingIntent.getActivity(ctx, if (callNoteNumber != null) 2 else 1, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }

        private fun notify(ctx: Context, id: Int, n: Notification) {
            if (Build.VERSION.SDK_INT >= 33 && ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
            ctx.getSystemService(NotificationManager::class.java).notify(id, n)
        }
    }
}
