import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../native.dart';
import '../theme.dart';
import '../widgets/bubble.dart';
import '../widgets/orb.dart';
import 'settings.dart';

/// Talk to your agent: type, hold the mic, or send a photo. Drafts, reminders, alerts and questions
/// from the agent arrive here too (the same chat as your WhatsApp messages to it).
class AssistantScreen extends StatefulWidget {
  const AssistantScreen({super.key, required this.onSignedOut});
  final VoidCallback onSignedOut;
  @override
  State<AssistantScreen> createState() => _AssistantScreenState();
}

class _AssistantScreenState extends State<AssistantScreen> {
  final _api = Api.instance;
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final List<Message> _messages = [];
  Timer? _poll;
  Timer? _levelTimer;
  bool _loading = true;
  bool _offline = false;
  bool _recording = false;
  double _level = 0;
  int? _playingId;
  int? _autoPlayAfter; // after sending a voice note, speak the next spoken reply aloud
  DateTime? _sentAt;
  bool _waiting = false;

  @override
  void initState() {
    super.initState();
    _refresh(first: true);
    _poll = Timer.periodic(const Duration(seconds: 2), (_) => _refresh());
  }

  @override
  void dispose() {
    _poll?.cancel();
    _levelTimer?.cancel();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  int get _lastId => _messages.isEmpty ? 0 : _messages.last.id;

  Future<void> _refresh({bool first = false}) async {
    try {
      final fresh = await _api.chat(after: first ? 0 : _lastId);
      if (!mounted) return;
      if (fresh.isNotEmpty) {
        setState(() {
          _messages.addAll(fresh.where((m) => !_messages.any((x) => x.id == m.id)));
          if (fresh.any((m) => m.direction == 'out')) _waiting = false;
        });
        _toBottom();
        final spoken = fresh.where((m) => m.direction == 'out' && m.audio != null).toList();
        if (_autoPlayAfter != null && spoken.isNotEmpty && spoken.last.id > _autoPlayAfter!) {
          _autoPlayAfter = null;
          _play(spoken.last);
        }
      }
      if (_offline || _loading) setState(() {
        _offline = false;
        _loading = false;
      });
      if (_waiting && _sentAt != null && DateTime.now().difference(_sentAt!).inMinutes >= 3) setState(() => _waiting = false);
    } on ApiError catch (e) {
      if (e.signedOut) {
        _poll?.cancel();
        widget.onSignedOut();
        return;
      }
      if (mounted) setState(() {
        _offline = true;
        _loading = false;
      });
    }
  }

  void _toBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) _scroll.animateTo(_scroll.position.maxScrollExtent + 200, duration: const Duration(milliseconds: 300), curve: Curves.easeOut);
    });
  }

  Future<void> _send([String? preset]) async {
    final text = (preset ?? _input.text).trim();
    if (text.isEmpty) return;
    _input.clear();
    setState(() {
      _waiting = true;
      _sentAt = DateTime.now();
    });
    try {
      await _api.say(text);
      await _refresh();
    } catch (e) {
      if (mounted) {
        setState(() => _waiting = false);
        showError(context, e);
        _input.text = text;
      }
    }
  }

  Future<void> _toggleRecording() async {
    if (_recording) return _stopRecording();
    await Native.requestPermissions(['microphone']);
    final ok = await Native.startRecording();
    if (!ok) {
      if (mounted) showError(context, 'Allow the microphone to talk to your agent.');
      return;
    }
    await Native.stopPlaying();
    setState(() {
      _recording = true;
      _playingId = null;
    });
    _levelTimer = Timer.periodic(const Duration(milliseconds: 90), (_) async {
      final l = await Native.level();
      if (mounted) setState(() => _level = l);
    });
  }

  Future<void> _stopRecording({bool cancel = false}) async {
    _levelTimer?.cancel();
    final r = await Native.stopRecording(cancel: cancel);
    setState(() {
      _recording = false;
      _level = 0;
    });
    if (cancel || r == null) return;
    setState(() {
      _waiting = true;
      _sentAt = DateTime.now();
    });
    try {
      _autoPlayAfter = _lastId;
      await _api.sendVoice(r.$1, r.$2);
    } catch (e) {
      if (mounted) {
        setState(() => _waiting = false);
        showError(context, e);
      }
    }
  }

  Future<void> _photo() async {
    final camera = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: AppColors.bg2,
      showDragHandle: true,
      builder: (c) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(leading: const Icon(Icons.photo_camera_rounded), title: const Text('Take a photo'), onTap: () => Navigator.pop(c, true)),
          ListTile(leading: const Icon(Icons.photo_library_rounded), title: const Text('Choose from gallery'), onTap: () => Navigator.pop(c, false)),
        ]),
      ),
    );
    if (camera == null) return;
    if (camera) await Native.requestPermissions(['camera']);
    final path = await Native.pickPhoto(camera: camera);
    if (path == null) return;
    final caption = _input.text.trim();
    _input.clear();
    setState(() {
      _waiting = true;
      _sentAt = DateTime.now();
    });
    try {
      await _api.sendPhoto(path, caption);
    } catch (e) {
      if (mounted) {
        setState(() => _waiting = false);
        showError(context, e);
      }
    }
  }

  Future<void> _play(Message m) async {
    if (_playingId == m.id) {
      await Native.stopPlaying();
      setState(() => _playingId = null);
      return;
    }
    setState(() => _playingId = m.id);
    try {
      await Native.play(_api.media(m.audio!), _api.authHeaders);
    } catch (e) {
      if (mounted) showError(context, "Couldn't play the voice note");
    }
    if (mounted && _playingId == m.id) setState(() => _playingId = null);
  }

  OrbState get _orbState {
    if (_offline) return OrbState.offline;
    if (_recording) return OrbState.listening;
    if (_playingId != null) return OrbState.speaking;
    if (_waiting) return OrbState.thinking;
    return OrbState.idle;
  }

  String get _status => switch (_orbState) {
        OrbState.offline => "Can't reach your agent",
        OrbState.listening => 'Listening… tap to send',
        OrbState.speaking => 'Speaking',
        OrbState.thinking => 'Thinking…',
        OrbState.idle => 'Online · ready',
      };

  String get _greeting {
    final h = DateTime.now().hour;
    final part = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    final name = _api.ownerName.isEmpty ? '' : ', ${_api.ownerName.split(' ').first}';
    return '$part$name';
  }

  // The agent asked for a yes/no (a draft, saving something, deleting…): show quick buttons.
  bool get _awaitingAnswer {
    if (_messages.isEmpty) return false;
    final m = _messages.last;
    if (m.direction != 'out') return false;
    return RegExp(r'"yes"|"no"|"نعم"|"لا"|yes/no', caseSensitive: false).hasMatch(m.text);
  }

  bool get _arabicLast => _messages.isNotEmpty && directionOf(_messages.last.text) == TextDirection.rtl;

  @override
  Widget build(BuildContext context) {
    final empty = !_loading && _messages.isEmpty;
    return SafeArea(
      bottom: false,
      child: Column(children: [
        _header(compact: !empty),
        if (_offline) _offlineBanner(),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : empty
                  ? _emptyState()
                  : ListView.builder(
                      controller: _scroll,
                      padding: const EdgeInsets.fromLTRB(14, 6, 14, 12),
                      itemCount: _messages.length,
                      itemBuilder: (_, i) {
                        final m = _messages[i];
                        return MessageBubble(m: m, mine: m.direction == 'in', playing: _playingId == m.id, onPlay: m.audio == null ? null : () => _play(m));
                      },
                    ),
        ),
        if (_awaitingAnswer && !_waiting) _answerChips(),
        _composer(),
        SizedBox(height: bottomGap(context)),
      ]),
    );
  }

  Widget _header({required bool compact}) {
    return AnimatedContainer(
      duration: const Duration(milliseconds: 350),
      curve: Curves.easeOutCubic,
      padding: EdgeInsets.fromLTRB(20, compact ? 8 : 24, 20, compact ? 6 : 12),
      child: compact
          ? Row(children: [
              GestureDetector(onTap: _toggleRecording, child: AgentOrb(state: _orbState, level: _level, size: 64)),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  GradientText(_api.company.isEmpty ? 'Your agent' : _api.company, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 2),
                  Row(children: [
                    Container(width: 7, height: 7, decoration: BoxDecoration(shape: BoxShape.circle, color: _offline ? AppColors.red : AppColors.green)),
                    const SizedBox(width: 6),
                    Text(_status, style: const TextStyle(color: AppColors.muted, fontSize: 13)),
                  ]),
                ]),
              ),
            ])
          : Column(children: [
              GestureDetector(onTap: _toggleRecording, child: AgentOrb(state: _orbState, level: _level, size: 200)),
              const SizedBox(height: 14),
              GradientText(_greeting, style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w700)),
              const SizedBox(height: 4),
              Text(_status, style: const TextStyle(color: AppColors.muted)),
            ]),
    );
  }

  // Can't reach the agent: offer another address (Wi-Fi changed, VPN on, computer's address changed).
  Widget _offlineBanner() => Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
        child: Glass(
          glow: AppColors.amber,
          padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
          child: Row(children: [
            const Icon(Icons.wifi_off_rounded, color: AppColors.amber),
            const SizedBox(width: 10),
            Expanded(child: Text("Can't reach your agent at ${_api.base}", style: const TextStyle(fontSize: 13))),
            TextButton(
              onPressed: () async {
                final r = await showAddressDialog(context);
                if (r == 'signin') return widget.onSignedOut();
                if (r != 'switched') return;
                // Restart the background connection and "Hey …" on the new address right away.
                final prefs = await AppPrefs.load();
                if (prefs.background && _api.cookie != null) {
                  await Native.startService(server: _api.base, cookie: _api.cookie!, owner: _api.ownerPhone, missedCalls: prefs.missedCalls, callNotes: prefs.callNotes);
                }
                if (prefs.wake) await prefs.applyWake();
                _refresh(first: true);
              },
              child: const Text('Change address'),
            ),
          ]),
        ),
      );

  Widget _emptyState() {
    const ideas = [
      ('What do I have tomorrow?', Icons.event_rounded),
      ('Summary of today', Icons.insights_rounded),
      ('ذكرني بكرا الساعة 10 اتصل بالمورد', Icons.alarm_rounded),
      ('Search the price of iPhone 16 Pro in UAE', Icons.travel_explore_rounded),
    ];
    return ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 12), children: [
      const Text('Try asking', style: TextStyle(color: AppColors.muted)),
      const SizedBox(height: 10),
      for (final (t, icon) in ideas)
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Glass(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
            onTap: () => _send(t),
            child: Row(children: [
              Icon(icon, color: AppColors.cyan, size: 20),
              const SizedBox(width: 12),
              Expanded(child: Directionality(textDirection: directionOf(t), child: Text(t))),
            ]),
          ),
        ),
      const SizedBox(height: 6),
      const Text('Tap the orb or the mic to talk. Send a photo of a business card, invoice or product and ask about it.',
          style: TextStyle(color: AppColors.muted, fontSize: 12)),
    ]);
  }

  Widget _answerChips() {
    final ar = _arabicLast;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      child: Row(children: [
        Expanded(child: _chip(ar ? 'نعم' : 'Yes', Icons.check_rounded, AppColors.green, () => _send(ar ? 'نعم' : 'yes'))),
        const SizedBox(width: 10),
        Expanded(child: _chip(ar ? 'لا' : 'No', Icons.close_rounded, AppColors.red, () => _send(ar ? 'لا' : 'no'))),
      ]),
    );
  }

  Widget _chip(String label, IconData icon, Color color, VoidCallback onTap) => Glass(
        padding: const EdgeInsets.symmetric(vertical: 12),
        radius: 14,
        glow: color,
        onTap: onTap,
        child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          Icon(icon, color: color, size: 18),
          const SizedBox(width: 6),
          Text(label, style: TextStyle(color: color, fontWeight: FontWeight.w600)),
        ]),
      );

  Widget _composer() {
    if (_recording) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(14, 4, 14, 8),
        child: Glass(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          radius: 28,
          glow: AppColors.cyan,
          child: Row(children: [
            IconButton(onPressed: () => _stopRecording(cancel: true), icon: const Icon(Icons.delete_outline_rounded, color: AppColors.muted)),
            Expanded(
              child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                for (var i = 0; i < 18; i++)
                  AnimatedContainer(
                    duration: const Duration(milliseconds: 90),
                    width: 3,
                    height: 4 + 26 * (_level * (0.4 + 0.6 * ((i * 7 % 10) / 10))),
                    margin: const EdgeInsets.symmetric(horizontal: 1.5),
                    decoration: BoxDecoration(color: AppColors.cyan, borderRadius: BorderRadius.circular(2)),
                  ),
              ]),
            ),
            _roundButton(Icons.send_rounded, () => _stopRecording()),
          ]),
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 4, 14, 8),
      child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        Expanded(
          child: Glass(
            padding: const EdgeInsets.only(left: 4, right: 4),
            radius: 26,
            child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
              IconButton(onPressed: _photo, icon: const Icon(Icons.add_photo_alternate_rounded, color: AppColors.muted)),
              Expanded(
                child: TextField(
                  controller: _input,
                  minLines: 1,
                  maxLines: 5,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (_) => _send(),
                  onChanged: (_) => setState(() {}),
                  decoration: const InputDecoration(
                    hintText: 'Ask or tell your agent…',
                    filled: false,
                    border: InputBorder.none,
                    enabledBorder: InputBorder.none,
                    focusedBorder: InputBorder.none,
                    contentPadding: EdgeInsets.symmetric(vertical: 14),
                  ),
                ),
              ),
            ]),
          ),
        ),
        const SizedBox(width: 8),
        _input.text.trim().isEmpty ? _roundButton(Icons.mic_rounded, _toggleRecording) : _roundButton(Icons.arrow_upward_rounded, () => _send()),
      ]),
    );
  }

  Widget _roundButton(IconData icon, VoidCallback onTap) => GestureDetector(
        onTap: onTap,
        child: Container(
          width: 50,
          height: 50,
          decoration: BoxDecoration(shape: BoxShape.circle, gradient: AppColors.accent, boxShadow: [
            BoxShadow(color: AppColors.violet.withValues(alpha: 0.4), blurRadius: 16, offset: const Offset(0, 4)),
          ]),
          child: Icon(icon, color: Colors.white),
        ),
      );
}
