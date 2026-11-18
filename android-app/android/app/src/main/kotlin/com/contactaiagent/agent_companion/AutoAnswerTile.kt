package com.contactaiagent.agent_companion

import android.content.ComponentName
import android.content.Context
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/** Quick settings tile: switch auto answer on/off from the pull-down shade. */
class AutoAnswerTile : TileService() {
    override fun onStartListening() = show()

    override fun onClick() {
        AgentService.setAutoAnswer(this, !AgentService.autoAnswer(this).on)
        show()
    }

    private fun show() {
        val t = qsTile ?: return
        val a = AgentService.autoAnswer(this)
        t.state = if (a.on) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        t.label = "Auto answer"
        if (android.os.Build.VERSION.SDK_INT >= 29) t.subtitle = if (a.on) "After ${a.rings} rings" else "Off"
        t.updateTile()
    }

    companion object {
        fun refresh(ctx: Context) = try {
            requestListeningState(ctx, ComponentName(ctx, AutoAnswerTile::class.java))
        } catch (_: Exception) {}
    }
}
