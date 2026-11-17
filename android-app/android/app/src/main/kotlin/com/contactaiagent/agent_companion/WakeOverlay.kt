package com.contactaiagent.agent_companion

import android.animation.ValueAnimator
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.provider.Settings
import android.text.TextUtils
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.view.animation.LinearInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.cos
import kotlin.math.sin

/**
 * The floating "assistant" panel at the bottom of the screen while "Hey …" is working, like the
 * Google/Siri/Bixby bars: a living orb, what it's doing, what it heard and its answer. Drawn over
 * other apps (needs "Display over other apps"); without that permission nothing is shown.
 */
class WakeOverlay(private val ctx: Context, private val onMic: () -> Unit) {
    private val wm = ctx.getSystemService(WindowManager::class.java)
    private var root: View? = null
    private lateinit var orb: OrbView
    private lateinit var status: TextView
    private lateinit var body: TextView
    private val dp = ctx.resources.displayMetrics.density
    private val main = Handler(Looper.getMainLooper())
    private val autoHide = Runnable { hide() }

    val allowed: Boolean get() = Settings.canDrawOverlays(ctx)

    fun show(state: String, text: String? = null) {
        if (!allowed) return
        if (root == null) build()
        update(state, text)
    }

    fun update(state: String, text: String? = null) {
        if (root == null) return
        main.removeCallbacks(autoHide)
        if (state == "done" || state == "error") main.postDelayed(autoHide, if (state == "error") 6000 else 4000)
        orb.state = state
        status.text = when (state) {
            "listening" -> "Listening…"
            "thinking" -> "Thinking…"
            "speaking" -> "Speaking…"
            "done" -> "Done"
            "error" -> "Something went wrong"
            else -> state
        }
        if (text != null) {
            body.text = text
            body.visibility = if (text.isBlank()) View.GONE else View.VISIBLE
            body.textDirection = if (Regex("[\\u0600-\\u06FF]").containsMatchIn(text.take(40))) View.TEXT_DIRECTION_RTL else View.TEXT_DIRECTION_LTR
        }
    }

    fun level(v: Float) {
        if (root != null) orb.level = v
    }

    fun hide() {
        main.removeCallbacks(autoHide)
        val r = root ?: return
        root = null
        orb.stop()
        r.animate().alpha(0f).translationY(40 * dp).setDuration(220).withEndAction {
            try { wm.removeView(r) } catch (_: Exception) {}
        }.start()
    }

    private fun build() {
        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding((14 * dp).toInt(), (12 * dp).toInt(), (10 * dp).toInt(), (12 * dp).toInt())
            background = GradientDrawable().apply {
                cornerRadius = 28 * dp
                setColor(Color.argb(240, 13, 19, 36))
                setStroke((1 * dp).toInt(), Color.argb(70, 139, 92, 246))
            }
            elevation = 12 * dp
        }
        orb = OrbView(ctx)
        card.addView(orb, LinearLayout.LayoutParams((52 * dp).toInt(), (52 * dp).toInt()))
        val texts = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((12 * dp).toInt(), 0, (6 * dp).toInt(), 0)
        }
        status = TextView(ctx).apply {
            setTextColor(Color.rgb(34, 211, 238))
            textSize = 13f
            typeface = Typeface.DEFAULT_BOLD
        }
        body = TextView(ctx).apply {
            setTextColor(Color.rgb(232, 236, 248))
            textSize = 15f
            maxLines = 4
            ellipsize = TextUtils.TruncateAt.END
            visibility = View.GONE
        }
        texts.addView(status)
        texts.addView(body)
        card.addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        // Speak again without the wake word.
        val mic = ImageView(ctx).apply {
            setImageResource(android.R.drawable.ic_btn_speak_now)
            setColorFilter(Color.WHITE)
            setPadding((10 * dp).toInt(), (10 * dp).toInt(), (10 * dp).toInt(), (10 * dp).toInt())
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                colors = intArrayOf(Color.rgb(34, 211, 238), Color.rgb(139, 92, 246))
                orientation = GradientDrawable.Orientation.TL_BR
            }
            contentDescription = "Speak again"
            setOnClickListener { onMic() }
        }
        card.addView(mic, LinearLayout.LayoutParams((44 * dp).toInt(), (44 * dp).toInt()))
        var downY = 0f
        card.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { downY = e.rawY; false }
                MotionEvent.ACTION_MOVE -> { val dy = e.rawY - downY; if (dy > 0) v.translationY = dy; dy > 10 * dp }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    val dy = e.rawY - downY
                    if (dy > 60 * dp) { hide(); true } else { v.animate().translationY(0f).setDuration(150).start(); dy > 10 * dp }
                }
                else -> false
            }
        }
        card.setOnClickListener {
            ctx.startActivity(Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
            hide()
        }
        val frame = FrameLayout(ctx).apply {
            setPadding((12 * dp).toInt(), 0, (12 * dp).toInt(), (20 * dp).toInt())
            addView(card)
        }
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
            PixelFormat.TRANSLUCENT,
        ).apply { gravity = Gravity.BOTTOM }
        // A tap anywhere outside the card closes it (the tap still reaches the app underneath).
        frame.setOnTouchListener { _, e -> if (e.actionMasked == MotionEvent.ACTION_OUTSIDE) { hide(); true } else false }
        frame.alpha = 0f
        frame.translationY = 40 * dp
        wm.addView(frame, lp)
        frame.animate().alpha(1f).translationY(0f).setInterpolator(DecelerateInterpolator()).setDuration(260).start()
        root = frame
    }

    /** The agent's orb: soft coloured blobs that swirl while thinking, pulse with the voice while listening. */
    private class OrbView(ctx: Context) : View(ctx) {
        var state = "listening"
        var level = 0f
            set(v) { field = field + (v - field) * 0.4f }
        private var t = 0f
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        private val colors = intArrayOf(Color.rgb(34, 211, 238), Color.rgb(139, 92, 246), Color.rgb(236, 72, 153))
        private val anim = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 4000
            repeatCount = ValueAnimator.INFINITE
            interpolator = LinearInterpolator()
            addUpdateListener { t = it.animatedValue as Float; invalidate() }
            start()
        }

        fun stop() = anim.cancel()

        override fun onDraw(c: Canvas) {
            val cx = width / 2f
            val cy = height / 2f
            val r = minOf(width, height) / 2f
            val speed = when (state) { "thinking" -> 4f; "speaking" -> 2f; else -> 1f }
            val pulse = when (state) {
                "listening" -> 0.82f + 0.18f * level
                "speaking" -> 0.85f + 0.1f * kotlin.math.abs(sin(t * 40))
                else -> 0.88f + 0.04f * sin(t * 12)
            }
            val core = r * pulse
            paint.shader = null
            paint.color = Color.rgb(11, 16, 34)
            c.drawCircle(cx, cy, core, paint)
            for (i in 0 until 3) {
                val a = (t * speed + i / 3f) * 2 * Math.PI
                val ox = (cos(a) * core * 0.35).toFloat()
                val oy = (sin(a * 1.3) * core * 0.35).toFloat()
                paint.shader = RadialGradient(cx + ox, cy + oy, core * 0.9f, colors[i] and 0xDDFFFFFF.toInt(), Color.TRANSPARENT, Shader.TileMode.CLAMP)
                c.drawCircle(cx, cy, core, paint)
            }
            paint.shader = null
        }
    }
}
