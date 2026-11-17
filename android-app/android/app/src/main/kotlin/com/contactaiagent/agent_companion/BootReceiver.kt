package com.contactaiagent.agent_companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Reconnects to the agent after the phone restarts (if the owner left notifications on). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (AgentService.enabled(context) && AgentService.config(context) != null) {
            try {
                context.startForegroundService(Intent(context, AgentService::class.java))
            } catch (_: Exception) {
                // Some ROMs block starting services at boot; the app starts it again when opened.
            }
        }
    }
}
