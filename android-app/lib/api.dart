import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

/// Talks to the Contact AI Agent dashboard (same sign-in as the web dashboard).
class Api {
  Api._();

  /// For tests and screenshots: a stand-in that returns sample data.
  @visibleForTesting
  Api.forTest();

  static Api instance = Api._();

  String base = '';
  String? cookie;
  String? ownerPhone;
  String ownerName = '';
  String company = '';

  bool get signedIn => base.isNotEmpty && cookie != null;

  Future<void> load() async {
    final p = await SharedPreferences.getInstance();
    base = p.getString('server') ?? '';
    cookie = p.getString('cookie');
    ownerPhone = p.getString('owner_phone');
    ownerName = p.getString('owner_name') ?? '';
    company = p.getString('company') ?? '';
  }

  Future<void> _save() async {
    final p = await SharedPreferences.getInstance();
    await p.setString('server', base);
    if (cookie != null) {
      await p.setString('cookie', cookie!);
    } else {
      await p.remove('cookie');
    }
    if (ownerPhone != null) await p.setString('owner_phone', ownerPhone!);
    await p.setString('owner_name', ownerName);
    await p.setString('company', company);
  }

  static String normalizeServer(String input) {
    var s = input.trim();
    if (s.isEmpty) return s;
    if (!s.startsWith('http://') && !s.startsWith('https://')) s = 'http://$s';
    final uri = Uri.parse(s);
    final port = uri.hasPort ? uri.port : (uri.scheme == 'https' ? 443 : 3000);
    final defaultPort = (uri.scheme == 'https' && port == 443) || (uri.scheme == 'http' && port == 80);
    return '${uri.scheme}://${uri.host}${defaultPort ? '' : ':$port'}';
  }

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (cookie != null) 'Cookie': cookie!,
      };

  Map<String, String> get authHeaders => {if (cookie != null) 'Cookie': cookie!};

  Uri _u(String path, [Map<String, String>? query]) => Uri.parse('$base/api$path').replace(queryParameters: query);

  dynamic _decode(http.Response r) {
    dynamic body;
    try {
      body = r.body.isEmpty ? null : jsonDecode(utf8.decode(r.bodyBytes));
    } catch (_) {
      body = null;
    }
    if (r.statusCode == 401) {
      throw ApiError('Signed out. Sign in again.', signedOut: true);
    }
    if (r.statusCode >= 400) {
      final msg = body is Map && body['error'] != null ? body['error'].toString() : 'Error ${r.statusCode}';
      throw ApiError(msg);
    }
    return body;
  }

  Future<T> _guard<T>(Future<T> Function() fn) async {
    try {
      return await fn().timeout(const Duration(seconds: 25));
    } on ApiError {
      rethrow;
    } on SocketException {
      throw ApiError("Can't reach the agent at $base. Is the phone on the same Wi-Fi and the dashboard running?");
    } on HttpException {
      throw ApiError("Can't reach the agent at $base.");
    } on Exception catch (e) {
      final s = e.toString();
      throw ApiError(s.contains('TimeoutException') ? 'The agent took too long to answer.' : s);
    }
  }

  Future<dynamic> get(String path, [Map<String, String>? query]) =>
      _guard(() async => _decode(await http.get(_u(path, query), headers: _headers)));

  Future<dynamic> post(String path, [Object? body]) =>
      _guard(() async => _decode(await http.post(_u(path), headers: _headers, body: jsonEncode(body ?? {}))));

  Future<dynamic> put(String path, Object body) =>
      _guard(() async => _decode(await http.put(_u(path), headers: _headers, body: jsonEncode(body))));

  Future<dynamic> upload(String path, {required String field, required String filePath, Map<String, String> fields = const {}}) =>
      _guard(() async {
        final req = http.MultipartRequest('POST', _u(path))
          ..headers.addAll(authHeaders)
          ..fields.addAll(fields)
          ..files.add(await http.MultipartFile.fromPath(field, filePath));
        final streamed = await req.send();
        return _decode(await http.Response.fromStream(streamed));
      });

  Future<void> signIn(String server, String username, String password) async {
    base = normalizeServer(server);
    cookie = null;
    final r = await _guard(() => http.post(_u('/login'),
        headers: {'Content-Type': 'application/json'}, body: jsonEncode({'username': username, 'password': password})));
    if (r.statusCode == 401) throw ApiError('Wrong username or password');
    _decode(r);
    final set = r.headers['set-cookie'];
    if (set == null) throw ApiError('The agent did not start a session');
    cookie = set.split(';').first;
    await _save();
  }

  Future<void> signOut() async {
    try {
      await post('/logout');
    } catch (_) {}
    cookie = null;
    await _save();
  }

  Future<OwnersInfo> owners() async {
    final b = await get('/app/owners') as Map<String, dynamic>;
    company = (b['company'] ?? '').toString();
    final list = (b['owners'] as List? ?? []).map((o) => Owner(o['name']?.toString() ?? '', o['phone'].toString())).toList();
    await _save();
    return OwnersInfo(b['enabled'] == true, list);
  }

  Future<void> chooseOwner(Owner o) async {
    ownerPhone = o.phone;
    ownerName = o.name;
    await _save();
  }

  Map<String, String> get _ownerQuery => {if (ownerPhone != null) 'owner': ownerPhone!};

  Future<List<Message>> chat({int after = 0}) async {
    final b = await get('/app/chat', {..._ownerQuery, 'after': '$after'}) as Map<String, dynamic>;
    return (b['messages'] as List).map((m) => Message.fromJson(m)).toList();
  }

  Future<void> say(String text) => post('/app/say', {'text': text, 'owner': ownerPhone});

  Future<void> sendVoice(String path, int seconds) =>
      upload('/app/voice', field: 'audio', filePath: path, fields: {'owner': ownerPhone ?? '', 'duration': '$seconds'});

  Future<void> sendPhoto(String path, String caption) =>
      upload('/app/photo', field: 'image', filePath: path, fields: {'owner': ownerPhone ?? '', 'caption': caption});

  Future<List<Conversation>> conversations({String? q}) async {
    final b = await get('/conversations', {if (q != null && q.isNotEmpty) 'q': q}) as List;
    return b.map((c) => Conversation.fromJson(c)).toList();
  }

  Future<(Conversation, List<Message>)> conversation(int id) async {
    final b = await get('/conversations/$id') as Map<String, dynamic>;
    return (Conversation.fromJson(b['conversation']), (b['messages'] as List).map((m) => Message.fromJson(m)).toList());
  }

  Future<void> reply(int id, String text) => post('/conversations/$id/messages', {'text': text});
  Future<void> aiReply(int id) => post('/conversations/$id/ai-reply');
  /// Read state, as the dashboard does when a chat is opened (unread = 0).
  Future<void> setUnread(int id, int unread) => _guard(() async =>
      _decode(await http.patch(_u('/conversations/$id'), headers: _headers, body: jsonEncode({'unread': unread}))));

  Future<void> setAuto(int id, bool on) => _guard(() async =>
      _decode(await http.patch(_u('/conversations/$id'), headers: _headers, body: jsonEncode({'auto_reply': on}))));

  Future<Map<String, dynamic>> settings() async => (await get('/settings') as Map).cast<String, dynamic>();
  Future<void> saveSetting(String key, Map<String, dynamic> value) => put('/settings', {key: value});

  Future<void> callNote(String number, String text, {String? name}) =>
      post('/app/call-note', {'number': number, 'text': text, if (name != null) 'name': name});

  /// Everything waiting for the owner's OK.
  Future<List<Map<String, dynamic>>> approvals() async {
    final r = await get('/app/approvals') as Map;
    return ((r['items'] as List?) ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList();
  }

  Future<Map<String, dynamic>> decide(String id, {required bool approve, String? text}) async =>
      ((await post('/app/approvals/${Uri.encodeComponent(id)}', {'approve': approve, if (text != null) 'text': text})) as Map).cast<String, dynamic>();

  Future<Map<String, dynamic>> stats() async => (await get('/stats') as Map).cast<String, dynamic>();

  String media(String file) => '$base/api/media/${Uri.encodeComponent(file)}';
}

class ApiError implements Exception {
  ApiError(this.message, {this.signedOut = false});
  final String message;
  final bool signedOut;
  @override
  String toString() => message;
}

class Owner {
  Owner(this.name, this.phone);
  final String name;
  final String phone;
}

class OwnersInfo {
  OwnersInfo(this.enabled, this.owners);
  final bool enabled;
  final List<Owner> owners;
}

class Message {
  Message({required this.id, required this.direction, required this.sender, required this.text, required this.meta, required this.createdAt, this.error});
  final int id;
  final String direction; // in | out | note
  final String sender;
  final String text;
  final Map<String, dynamic> meta;
  final DateTime createdAt;
  final String? error;

  bool get fromOwnerSide => direction == 'in';
  String? get audio => meta['audio']?.toString();
  String? get image => meta['image']?.toString();
  bool get isVoice => meta['voice'] == true;

  /// The words without the "[Photo: …]" description the agent adds for itself.
  String get visibleText {
    final i = text.indexOf('[Photo:');
    final t = i >= 0 ? text.substring(0, i).trim() : text;
    return t;
  }

  String? get photoDescription {
    final i = text.indexOf('[Photo:');
    if (i < 0) return null;
    var d = text.substring(i + 7).trim();
    if (d.endsWith(']')) d = d.substring(0, d.length - 1);
    return d.trim();
  }

  static DateTime _date(dynamic v) {
    final s = v?.toString() ?? '';
    return DateTime.tryParse(s.contains('T') ? s : '${s.replaceFirst(' ', 'T')}Z')?.toLocal() ?? DateTime.now();
  }

  factory Message.fromJson(dynamic m) {
    final meta = m['meta'];
    return Message(
      id: (m['id'] as num).toInt(),
      direction: m['direction']?.toString() ?? 'in',
      sender: m['sender']?.toString() ?? '',
      text: m['text']?.toString() ?? '',
      meta: meta is Map ? meta.cast<String, dynamic>() : (meta is String && meta.isNotEmpty ? (jsonDecode(meta) as Map).cast<String, dynamic>() : {}),
      createdAt: _date(m['created_at']),
      error: m['error']?.toString(),
    );
  }
}

class Conversation {
  Conversation({required this.id, required this.channel, required this.name, required this.handle, required this.lastMessage, required this.lastAt, required this.unread, required this.autoReply, required this.meta});
  final int id;
  final String channel;
  final String name;
  final String handle;
  final String lastMessage;
  final DateTime lastAt;
  final int unread;
  final bool autoReply;
  final Map<String, dynamic> meta;

  String get title => name.isNotEmpty ? name : (handle.isNotEmpty ? handle : 'Unknown');

  factory Conversation.fromJson(dynamic c) => Conversation(
        id: (c['id'] as num).toInt(),
        channel: c['channel']?.toString() ?? '',
        name: c['contact_name']?.toString() ?? '',
        handle: c['contact_handle']?.toString() ?? '',
        lastMessage: c['last_message']?.toString() ?? '',
        lastAt: Message._date(c['last_message_at']),
        unread: (c['unread'] as num?)?.toInt() ?? 0,
        autoReply: c['auto_reply'] == 1 || c['auto_reply'] == true,
        meta: c['meta'] is Map ? (c['meta'] as Map).cast<String, dynamic>() : {},
      );
}
