import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../native.dart';
import '../theme.dart';
import '../widgets/bubble.dart';

const _channelIcons = {
  'whatsapp': (Icons.chat_rounded, Color(0xFF25D366)),
  'telegram': (Icons.send_rounded, Color(0xFF29B6F6)),
  'email': (Icons.mail_rounded, AppColors.amber),
  'facebook': (Icons.facebook_rounded, Color(0xFF1877F2)),
  'instagram': (Icons.camera_alt_rounded, AppColors.pink),
};

/// All customer chats from every channel, live.
class InboxScreen extends StatefulWidget {
  const InboxScreen({super.key, required this.onSignedOut});
  final VoidCallback onSignedOut;
  @override
  State<InboxScreen> createState() => _InboxScreenState();
}

class _InboxScreenState extends State<InboxScreen> {
  List<Conversation>? _items;
  Timer? _poll;
  String _q = '';
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
    _poll = Timer.periodic(const Duration(seconds: 6), (_) => _load());
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final list = await Api.instance.conversations(q: _q);
      if (mounted) setState(() {
        _items = list;
        _error = null;
      });
    } on ApiError catch (e) {
      if (e.signedOut) return widget.onSignedOut();
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final items = _items;
    return SafeArea(
      bottom: false,
      child: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
          child: Row(children: [
            const GradientText('Inbox', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700)),
            const Spacer(),
            if (items != null) Text('${items.where((c) => c.unread > 0).length} unread', style: const TextStyle(color: AppColors.muted)),
          ]),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          child: TextField(
            onChanged: (v) {
              _q = v;
              _load();
            },
            decoration: const InputDecoration(hintText: 'Search chats', prefixIcon: Icon(Icons.search_rounded), isDense: true),
          ),
        ),
        if (_error != null) Padding(padding: const EdgeInsets.all(8), child: Text(_error!, style: const TextStyle(color: AppColors.red))),
        Expanded(
          child: items == null
              ? const Center(child: CircularProgressIndicator())
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView.separated(
                    padding: const EdgeInsets.fromLTRB(12, 4, 12, 90),
                    itemCount: items.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 8),
                    itemBuilder: (_, i) => _tile(items[i]),
                  ),
                ),
        ),
      ]),
    );
  }

  Widget _tile(Conversation c) {
    final (icon, color) = _channelIcons[c.channel] ?? (Icons.chat_bubble_rounded, AppColors.muted);
    final preview = c.lastMessage.replaceAll(RegExp(r'\s*\[Photo:[\s\S]*$'), ' 📷');
    return Glass(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      glow: c.unread > 0 ? AppColors.cyan : null,
      onTap: () async {
        await Navigator.of(context).push(MaterialPageRoute(builder: (_) => ConversationScreen(id: c.id, title: c.title)));
        _load();
      },
      child: Row(children: [
        Stack(clipBehavior: Clip.none, children: [
          CircleAvatar(
            radius: 22,
            backgroundColor: AppColors.violet.withValues(alpha: 0.25),
            child: Text(c.title.characters.first.toUpperCase(), style: const TextStyle(fontWeight: FontWeight.w600)),
          ),
          Positioned(
            right: -2,
            bottom: -2,
            child: Container(
              padding: const EdgeInsets.all(3),
              decoration: BoxDecoration(color: AppColors.bg2, shape: BoxShape.circle, border: Border.all(color: AppColors.bg2, width: 1.5)),
              child: Icon(icon, size: 12, color: color),
            ),
          ),
        ]),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text(c.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600))),
              Text(_ago(c.lastAt), style: const TextStyle(color: AppColors.muted, fontSize: 12)),
            ]),
            const SizedBox(height: 3),
            Row(children: [
              if (!c.autoReply) const Padding(padding: EdgeInsets.only(right: 4), child: Icon(Icons.person_rounded, size: 14, color: AppColors.amber)),
              Expanded(
                child: Text(preview, maxLines: 1, overflow: TextOverflow.ellipsis, textDirection: directionOf(preview), style: const TextStyle(color: AppColors.muted)),
              ),
              if (c.unread > 0)
                Container(
                  margin: const EdgeInsets.only(left: 6),
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                  decoration: BoxDecoration(gradient: AppColors.accent, borderRadius: BorderRadius.circular(10)),
                  child: Text('${c.unread}', style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700)),
                ),
            ]),
          ]),
        ),
      ]),
    );
  }

  static String _ago(DateTime d) {
    final diff = DateTime.now().difference(d);
    if (diff.inMinutes < 1) return 'now';
    if (diff.inHours < 1) return '${diff.inMinutes}m';
    if (diff.inDays < 1) return '${diff.inHours}h';
    if (diff.inDays < 7) return '${diff.inDays}d';
    return '${d.day}/${d.month}';
  }
}

/// One customer chat: read it, answer yourself, or ask the AI to answer.
class ConversationScreen extends StatefulWidget {
  const ConversationScreen({super.key, required this.id, required this.title});
  final int id;
  final String title;
  @override
  State<ConversationScreen> createState() => _ConversationScreenState();
}

class _ConversationScreenState extends State<ConversationScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  Conversation? _conv;
  List<Message> _messages = [];
  Timer? _poll;
  int? _playingId;
  bool _sending = false;

  @override
  void initState() {
    super.initState();
    _load(scroll: true);
    _poll = Timer.periodic(const Duration(seconds: 3), (_) => _load());
  }

  @override
  void dispose() {
    _poll?.cancel();
    Native.stopPlaying();
    super.dispose();
  }

  Future<void> _load({bool scroll = false}) async {
    try {
      final (c, msgs) = await Api.instance.conversation(widget.id);
      if (!mounted) return;
      final grew = msgs.length != _messages.length;
      setState(() {
        _conv = c;
        _messages = msgs;
      });
      if (scroll || grew) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
        });
      }
    } catch (_) {}
  }

  Future<void> _send() async {
    final t = _input.text.trim();
    if (t.isEmpty) return;
    setState(() => _sending = true);
    try {
      await Api.instance.reply(widget.id, t);
      _input.clear();
      await _load(scroll: true);
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _play(Message m) async {
    if (_playingId == m.id) {
      await Native.stopPlaying();
      return setState(() => _playingId = null);
    }
    setState(() => _playingId = m.id);
    try {
      await Native.play(Api.instance.media(m.audio!), Api.instance.authHeaders);
    } catch (_) {}
    if (mounted && _playingId == m.id) setState(() => _playingId = null);
  }

  @override
  Widget build(BuildContext context) {
    final c = _conv;
    return Scaffold(
      body: AgentBackground(
        child: SafeArea(
          child: Column(children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 4, 12, 4),
              child: Row(children: [
                IconButton(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.arrow_back_rounded)),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(widget.title, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600), maxLines: 1, overflow: TextOverflow.ellipsis),
                    if (c != null) Text('${c.channel} · ${c.handle}', style: const TextStyle(color: AppColors.muted, fontSize: 12)),
                  ]),
                ),
                if (c != null)
                  Row(children: [
                    Text(c.autoReply ? 'AI' : 'You', style: TextStyle(color: c.autoReply ? AppColors.cyan : AppColors.amber, fontSize: 12)),
                    Switch(
                      value: c.autoReply,
                      onChanged: (v) async {
                        await Api.instance.setAuto(widget.id, v);
                        _load();
                      },
                    ),
                  ]),
              ]),
            ),
            Expanded(
              child: ListView.builder(
                controller: _scroll,
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                itemCount: _messages.length,
                itemBuilder: (_, i) {
                  final m = _messages[i];
                  // Customer on the left, the business (AI or team) on the right.
                  return MessageBubble(
                    m: m,
                    mine: m.direction == 'out',
                    otherInitial: widget.title.characters.first.toUpperCase(),
                    playing: _playingId == m.id,
                    onPlay: m.audio == null ? null : () => _play(m),
                  );
                },
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
              child: Row(children: [
                IconButton(
                  tooltip: 'Let the AI answer',
                  onPressed: () async {
                    final messenger = ScaffoldMessenger.of(context);
                    try {
                      await Api.instance.aiReply(widget.id);
                      messenger.showSnackBar(const SnackBar(content: Text('The AI is writing an answer…')));
                    } catch (e) {
                      messenger.showSnackBar(SnackBar(content: Text(e.toString())));
                    }
                  },
                  icon: const Icon(Icons.auto_awesome_rounded, color: AppColors.cyan),
                ),
                Expanded(
                  child: TextField(
                    controller: _input,
                    minLines: 1,
                    maxLines: 4,
                    decoration: const InputDecoration(hintText: 'Reply as the team…', isDense: true),
                  ),
                ),
                const SizedBox(width: 8),
                _sending
                    ? const SizedBox(width: 44, height: 44, child: Padding(padding: EdgeInsets.all(10), child: CircularProgressIndicator(strokeWidth: 2)))
                    : IconButton.filled(onPressed: _send, icon: const Icon(Icons.send_rounded)),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}
