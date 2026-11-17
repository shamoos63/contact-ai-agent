import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

/// Everything waiting for the owner's OK: customer answers in draft mode, messages and emails
/// waiting for "yes", things to learn or save, and customer questions the agent couldn't answer.
/// Approve as is, approve with your own text, or reject. WhatsApp shows the same result.
class ApprovalsScreen extends StatefulWidget {
  const ApprovalsScreen({super.key, required this.onCount});
  final ValueChanged<int> onCount;
  @override
  State<ApprovalsScreen> createState() => _ApprovalsScreenState();
}

class _ApprovalsScreenState extends State<ApprovalsScreen> {
  List<Map<String, dynamic>>? _items;
  String? _error;
  Timer? _poll;
  final Set<String> _busy = {};

  @override
  void initState() {
    super.initState();
    _load();
    _poll = Timer.periodic(const Duration(seconds: 8), (_) => _load());
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final items = await Api.instance.approvals();
      if (!mounted) return;
      setState(() {
        _items = items;
        _error = null;
      });
      widget.onCount(items.length);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  Future<void> _decide(Map<String, dynamic> item, bool approve, {String? text}) async {
    final id = item['id'] as String;
    setState(() => _busy.add(id));
    try {
      final r = await Api.instance.decide(id, approve: approve, text: text);
      if (!mounted) return;
      final result = (r['result'] ?? r['error'] ?? (approve ? 'Done' : 'Rejected')).toString();
      showInfo(context, result.split('\n').first);
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy.remove(id));
      _load();
    }
  }

  // Edit the text (or write the answer), then approve with it.
  Future<void> _edit(Map<String, dynamic> item) async {
    final needsText = item['needsText'] == true;
    final ctl = TextEditingController(text: needsText ? '' : (item['text'] ?? '').toString());
    final text = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.bg2,
      showDragHandle: true,
      builder: (c) => Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, MediaQuery.of(c).viewInsets.bottom + 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(needsText ? 'Your answer' : 'Edit before sending', style: Theme.of(c).textTheme.titleMedium),
          const SizedBox(height: 4),
          Text((item['title'] ?? '').toString(), style: const TextStyle(color: AppColors.muted)),
          if (needsText) ...[
            const SizedBox(height: 8),
            Text((item['text'] ?? '').toString(), textDirection: _dir(item['text'])),
          ],
          const SizedBox(height: 12),
          TextField(
            controller: ctl,
            autofocus: true,
            minLines: 3,
            maxLines: 10,
            textDirection: _dir(ctl.text),
            decoration: InputDecoration(hintText: needsText ? 'Write the answer the customer gets' : 'Change the text'),
          ),
          const SizedBox(height: 14),
          GradientButton(label: 'Send', icon: Icons.send_rounded, onPressed: () => Navigator.pop(c, ctl.text.trim())),
        ]),
      ),
    );
    if (text == null || text.isEmpty) return;
    await _decide(item, true, text: text);
  }

  static TextDirection _dir(Object? t) =>
      RegExp(r'[؀-ۿ]').hasMatch((t ?? '').toString()) ? TextDirection.rtl : TextDirection.ltr;

  static (IconData, Color) _icon(String kind) => switch (kind) {
        'draft' => (Icons.mark_chat_unread_rounded, AppColors.cyan),
        'question' => (Icons.help_rounded, AppColors.amber),
        'message' => (Icons.chat_rounded, const Color(0xFF25D366)),
        'email' => (Icons.mail_rounded, AppColors.amber),
        'answer' => (Icons.reply_rounded, AppColors.cyan),
        'deadlines' => (Icons.event_rounded, AppColors.pink),
        'learn' => (Icons.school_rounded, AppColors.violet),
        _ => (Icons.task_alt_rounded, AppColors.violet),
      };

  @override
  Widget build(BuildContext context) {
    final items = _items;
    return SafeArea(
      bottom: false,
      child: RefreshIndicator(
        onRefresh: _load,
        child: ListView(padding: const EdgeInsets.fromLTRB(16, 16, 16, 100), children: [
          const GradientText('Approvals', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          const Text('What your agent is waiting on you for.', style: TextStyle(color: AppColors.muted)),
          const SizedBox(height: 14),
          if (_error != null && items == null)
            Glass(child: Text(_error!, style: const TextStyle(color: AppColors.red)))
          else if (items == null)
            const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator()))
          else if (items.isEmpty)
            const Glass(
              child: Row(children: [
                Icon(Icons.check_circle_rounded, color: AppColors.green),
                SizedBox(width: 10),
                Expanded(child: Text('Nothing waiting. You\'re all caught up.')),
              ]),
            )
          else
            for (final it in items) ...[_card(it), const SizedBox(height: 12)],
        ]),
      ),
    );
  }

  Widget _card(Map<String, dynamic> it) {
    final kind = (it['kind'] ?? '').toString();
    final (icon, color) = _icon(kind);
    final busy = _busy.contains(it['id']);
    final needsText = it['needsText'] == true;
    final question = (it['question'] ?? '').toString();
    return Glass(
      glow: color,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(icon, color: color),
          const SizedBox(width: 10),
          Expanded(child: Text((it['title'] ?? '').toString(), style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15), textDirection: _dir(it['title']))),
        ]),
        if (question.isNotEmpty) ...[
          const SizedBox(height: 8),
          Text('“$question”', style: const TextStyle(color: AppColors.muted, fontSize: 13), textDirection: _dir(question)),
        ],
        const SizedBox(height: 8),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: AppColors.card, borderRadius: BorderRadius.circular(14), border: Border.all(color: AppColors.cardBorder)),
          child: Text((it['text'] ?? '').toString(), textDirection: _dir(it['text'])),
        ),
        const SizedBox(height: 12),
        if (busy)
          const LinearProgressIndicator()
        else
          Row(children: [
            if (!needsText)
              Expanded(child: GradientButton(label: 'Approve', icon: Icons.check_rounded, onPressed: () => _decide(it, true))),
            if (it['editable'] == true) ...[
              if (!needsText) const SizedBox(width: 8),
              Expanded(
                child: needsText
                    ? GradientButton(label: 'Write answer', icon: Icons.edit_rounded, onPressed: () => _edit(it))
                    : OutlinedButton.icon(onPressed: () => _edit(it), icon: const Icon(Icons.edit_rounded), label: const Text('Edit')),
              ),
            ],
            const SizedBox(width: 8),
            IconButton(
              tooltip: needsText ? 'Skip' : 'Reject',
              onPressed: () => _decide(it, false),
              icon: const Icon(Icons.close_rounded, color: AppColors.red),
            ),
          ]),
      ]),
    );
  }
}
