import 'package:flutter/services.dart';

/// The Android side: recording, playback, photos, the background service and the call lab.
class Native {
  static const _ch = MethodChannel('agent/native');

  static Future<bool> startRecording() async => await _ch.invokeMethod<bool>('startRecording') ?? false;

  /// Returns [path, seconds] or null when the recording was too short.
  static Future<(String, int)?> stopRecording({bool cancel = false}) async {
    final r = await _ch.invokeMapMethod<String, dynamic>('stopRecording', {'cancel': cancel});
    if (r == null || r['path'] == null) return null;
    return (r['path'] as String, (r['seconds'] as num?)?.toInt() ?? 0);
  }

  static Future<double> level() async => (await _ch.invokeMethod<num>('level'))?.toDouble() ?? 0;

  static Future<void> play(String url, Map<String, String> headers) => _ch.invokeMethod('play', {'url': url, 'headers': headers});
  static Future<void> stopPlaying() => _ch.invokeMethod('stopPlaying');

  /// Opens the gallery (or the camera) and returns a local file path.
  static Future<String?> pickPhoto({bool camera = false}) => _ch.invokeMethod<String>('pickPhoto', {'camera': camera});

  static Future<Map<String, bool>> permissions() async =>
      (await _ch.invokeMapMethod<String, bool>('permissions')) ?? {};
  static Future<void> requestPermissions(List<String> which) => _ch.invokeMethod('requestPermissions', {'which': which});

  /// The background service: notifications for alerts and questions, missed calls, call notes.
  static Future<void> startService({required String server, required String cookie, required String? owner, required bool missedCalls, required bool callNotes}) =>
      _ch.invokeMethod('startService', {'server': server, 'cookie': cookie, 'owner': owner, 'missedCalls': missedCalls, 'callNotes': callNotes});
  static Future<void> stopService() => _ch.invokeMethod('stopService');
  static Future<bool> serviceRunning() async => await _ch.invokeMethod<bool>('serviceRunning') ?? false;

  static Future<List<Map<String, dynamic>>> recentCalls() async {
    final r = await _ch.invokeListMethod<Map>('recentCalls') ?? [];
    return r.map((m) => m.cast<String, dynamic>()).toList();
  }

  /// A number opened from a "add a call note" notification, once.
  static Future<String?> pendingCallNote() => _ch.invokeMethod<String>('pendingCallNote');

  /// "Hey <name>": listen on the phone for the wake phrase, then send the command to the agent.
  static Future<void> wakeStart({required String name, required bool speak, required bool onlyCharging}) =>
      _ch.invokeMethod('wakeStart', {'name': name, 'speak': speak, 'onlyCharging': onlyCharging});
  static Future<void> wakeStop() => _ch.invokeMethod('wakeStop');
  static Future<Map<String, dynamic>> wakeStatus() async =>
      (await _ch.invokeMapMethod<String, dynamic>('wakeStatus')) ?? {'state': 'off'};

  /// During a real call: can the app hear the call and speak into it?
  static Future<List<Map<String, dynamic>>> liveCallTest() async {
    final r = await _ch.invokeListMethod<Map>('liveCallTest') ?? [];
    return r.map((m) => m.cast<String, dynamic>()).toList();
  }

  static Future<List<Map<String, dynamic>>> callLab() async {
    final r = await _ch.invokeListMethod<Map>('callLab') ?? [];
    return r.map((m) => m.cast<String, dynamic>()).toList();
  }
}
