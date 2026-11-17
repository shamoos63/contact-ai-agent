package com.contactaiagent.agent_companion

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.CallLog
import android.provider.MediaStore
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import kotlin.concurrent.thread

/**
 * The Flutter app's Android side: microphone, voice playback, photos, permissions, the background
 * service, the call log and the call lab.
 */
class MainActivity : FlutterActivity() {
    private var recorder: MediaRecorder? = null
    private var recordFile: File? = null
    private var recordStarted = 0L
    private var player: MediaPlayer? = null
    private var playResult: MethodChannel.Result? = null
    private var photoResult: MethodChannel.Result? = null
    private var cameraFile: File? = null
    private var permissionResult: MethodChannel.Result? = null
    private var pendingCallNote: String? = null
    private var pendingOpen: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        readCallNoteIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        readCallNoteIntent(intent)
    }

    private fun readCallNoteIntent(intent: Intent?) {
        intent?.getStringExtra(AgentService.EXTRA_CALL_NOTE)?.let { pendingCallNote = it }
        intent?.getStringExtra(AgentService.EXTRA_OPEN)?.let { pendingOpen = it }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "agent/native").setMethodCallHandler { call, result ->
            try {
                handle(call, result)
            } catch (e: Exception) {
                result.error("native", e.message ?: e.toString(), null)
            }
        }
    }

    private fun handle(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "startRecording" -> result.success(startRecording())
            "stopRecording" -> result.success(stopRecording(call.argument<Boolean>("cancel") == true))
            "level" -> result.success(level())
            "play" -> play(call.argument<String>("url")!!, call.argument<Map<String, String>>("headers") ?: emptyMap(), result)
            "stopPlaying" -> { stopPlaying(); result.success(null) }
            "pickPhoto" -> pickPhoto(call.argument<Boolean>("camera") == true, result)
            "permissions" -> result.success(permissionStates())
            "requestPermissions" -> requestPerms(call.argument<List<String>>("which") ?: emptyList(), result)
            "startService" -> {
                AgentService.configure(
                    this,
                    call.argument<String>("server")!!,
                    call.argument<String>("cookie")!!,
                    call.argument<String>("owner"),
                    call.argument<Boolean>("missedCalls") == true,
                    call.argument<Boolean>("callNotes") == true,
                )
                AgentService.start(this)
                result.success(null)
            }
            "stopService" -> { AgentService.stop(this); result.success(null) }
            "serviceRunning" -> result.success(AgentService.running)
            "wakeStart" -> {
                WakeWordService.configure(
                    this,
                    true,
                    call.argument<String>("name") ?: "Jarvis",
                    call.argument<Boolean>("speak") != false,
                    call.argument<Boolean>("onlyCharging") == true,
                )
                WakeWordService.start(this)
                result.success(null)
            }
            "wakeStop" -> {
                WakeWordService.configure(this, false, WakeWordService.config(this).name, WakeWordService.config(this).speak, WakeWordService.config(this).onlyCharging)
                WakeWordService.stop(this)
                result.success(null)
            }
            "wakeStatus" -> result.success(WakeWordService.status(this) + mapOf(
                "overlay" to WakeWordService.config(this).overlay,
                "overlayAllowed" to android.provider.Settings.canDrawOverlays(this),
            ))
            "setOverlay" -> { WakeWordService.setOverlay(this, call.argument<Boolean>("on") != false); result.success(null) }
            "openOverlaySettings" -> {
                startActivity(Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
                result.success(null)
            }
            "recentCalls" -> result.success(recentCalls())
            "pendingCallNote" -> { result.success(pendingCallNote); pendingCallNote = null }
            "pendingOpen" -> { result.success(pendingOpen); pendingOpen = null }
            "callLab" -> thread { val r = CallLab.run(this); runOnUiThread { result.success(r) } }
            else -> result.notImplemented()
        }
    }

    // --- Microphone ---

    private fun startRecording(): Boolean {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return false
        stopRecording(true)
        val file = File(cacheDir, "voice-${System.currentTimeMillis()}.m4a")
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(this) else @Suppress("DEPRECATION") MediaRecorder()
        r.setAudioSource(MediaRecorder.AudioSource.MIC)
        r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        r.setAudioSamplingRate(44100)
        r.setAudioChannels(1)
        r.setAudioEncodingBitRate(96000)
        r.setOutputFile(file.absolutePath)
        r.prepare()
        r.start()
        recorder = r
        recordFile = file
        recordStarted = System.currentTimeMillis()
        return true
    }

    private fun stopRecording(cancel: Boolean): Map<String, Any?>? {
        val r = recorder ?: return null
        recorder = null
        val seconds = ((System.currentTimeMillis() - recordStarted) / 1000).toInt()
        val ok = try { r.stop(); true } catch (e: Exception) { false }
        r.release()
        val file = recordFile
        if (cancel || !ok || file == null || seconds < 1) { file?.delete(); return null }
        return mapOf("path" to file.absolutePath, "seconds" to seconds)
    }

    private fun level(): Double {
        val r = recorder ?: return 0.0
        return try { Math.sqrt((r.maxAmplitude / 32767.0).coerceIn(0.0, 1.0)) } catch (e: Exception) { 0.0 }
    }

    // --- Playback (voice notes from the agent) ---

    private fun play(url: String, headers: Map<String, String>, result: MethodChannel.Result) {
        stopPlaying()
        playResult = result
        val p = MediaPlayer()
        player = p
        p.setDataSource(this, Uri.parse(url), headers)
        p.setOnPreparedListener { it.start() }
        p.setOnCompletionListener { finishPlaying(null) }
        p.setOnErrorListener { _, what, extra -> finishPlaying("Playback failed ($what/$extra)"); true }
        p.prepareAsync()
    }

    private fun finishPlaying(error: String?) {
        player?.release()
        player = null
        val r = playResult ?: return
        playResult = null
        if (error == null) r.success(null) else r.error("play", error, null)
    }

    private fun stopPlaying() {
        try { player?.stop() } catch (_: Exception) {}
        finishPlaying(null)
    }

    // --- Photos ---

    private fun pickPhoto(camera: Boolean, result: MethodChannel.Result) {
        photoResult?.success(null)
        photoResult = result
        if (camera) {
            val dir = File(cacheDir, "photos").apply { mkdirs() }
            val file = File(dir, "photo-${System.currentTimeMillis()}.jpg")
            cameraFile = file
            val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
            val i = Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, uri)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            startActivityForResult(i, REQ_CAMERA)
        } else {
            val i = Intent(Intent.ACTION_GET_CONTENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE)
            startActivityForResult(Intent.createChooser(i, "Choose a photo"), REQ_GALLERY)
        }
    }

    @Deprecated("Platform activity results, which FlutterActivity supports")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_CAMERA && requestCode != REQ_GALLERY) return
        val r = photoResult ?: return
        photoResult = null
        if (resultCode != Activity.RESULT_OK) return r.success(null)
        if (requestCode == REQ_CAMERA) {
            val f = cameraFile
            return r.success(if (f != null && f.length() > 0) f.absolutePath else null)
        }
        val uri = data?.data ?: return r.success(null)
        thread {
            val path = try {
                val dir = File(cacheDir, "photos").apply { mkdirs() }
                val out = File(dir, "pick-${System.currentTimeMillis()}.jpg")
                contentResolver.openInputStream(uri)!!.use { input -> out.outputStream().use { input.copyTo(it) } }
                out.absolutePath
            } catch (e: Exception) { null }
            runOnUiThread { r.success(path) }
        }
    }

    // --- Permissions ---

    private fun permsFor(name: String): List<String> = when (name) {
        "microphone" -> listOf(Manifest.permission.RECORD_AUDIO)
        "camera" -> listOf(Manifest.permission.CAMERA)
        "phone" -> listOf(Manifest.permission.READ_PHONE_STATE, Manifest.permission.READ_CALL_LOG)
        "notifications" -> if (Build.VERSION.SDK_INT >= 33) listOf(Manifest.permission.POST_NOTIFICATIONS) else emptyList()
        else -> emptyList()
    }

    private fun granted(names: List<String>) = names.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    private fun permissionStates(): Map<String, Boolean> =
        listOf("microphone", "camera", "phone", "notifications").associateWith { granted(permsFor(it)) }

    private fun requestPerms(which: List<String>, result: MethodChannel.Result) {
        val missing = which.flatMap { permsFor(it) }.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) return result.success(true)
        permissionResult?.success(false)
        permissionResult = result
        requestPermissions(missing.toTypedArray(), REQ_PERMS)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_PERMS) return
        permissionResult?.success(grantResults.all { it == PackageManager.PERMISSION_GRANTED })
        permissionResult = null
    }

    // --- Call log ---

    private fun recentCalls(): List<Map<String, Any?>> {
        if (checkSelfPermission(Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) return emptyList()
        val out = mutableListOf<Map<String, Any?>>()
        contentResolver.query(
            CallLog.Calls.CONTENT_URI,
            arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION),
            null, null, "${CallLog.Calls.DATE} DESC",
        )?.use { c ->
            while (c.moveToNext() && out.size < 30) {
                out.add(mapOf(
                    "number" to c.getString(0),
                    "name" to c.getString(1),
                    "type" to when (c.getInt(2)) {
                        CallLog.Calls.MISSED_TYPE, CallLog.Calls.REJECTED_TYPE -> "missed"
                        CallLog.Calls.OUTGOING_TYPE -> "outgoing"
                        else -> "incoming"
                    },
                    "date" to c.getLong(3),
                    "duration" to c.getLong(4),
                ))
            }
        }
        return out
    }

    override fun onDestroy() {
        stopRecording(true)
        stopPlaying()
        super.onDestroy()
    }

    companion object {
        private const val REQ_CAMERA = 41
        private const val REQ_GALLERY = 42
        private const val REQ_PERMS = 43
    }
}
