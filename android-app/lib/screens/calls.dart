import 'package:flutter/material.dart';

import '../api.dart';
import '../native.dart';
import '../theme.dart';
import 'settings.dart';

/// Calls on this phone: missed calls get a WhatsApp from the agent (if turned on in the dashboard),
/// notes after calls go to that customer's memory, and the Call lab checks what this phone can do
/// for future AI phone calls.
class CallsScreen extends StatefulWidget {
  const CallsScreen({super.key, this.noteFor, required this.onNoteHandled});
  final String? noteFor;
  final VoidCallback onNoteHandled;
  @override
  State<CallsScreen> createState() => _CallsScreenState();
}

class _CallsScreenState extends State<CallsScreen> {
  List<Map<String, dynamic>>? _calls;
  List<Map<String, dynamic>>? _lab;
  bool _labRunning = false;
  bool? _missedReply;
  String? _handled;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(CallsScreen old) {
    super.didUpdateWidget(old);
    final n = widget.noteFor;
    if (n != null && n != _handled) {
      _handled = n;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _addNote(n, null);
        widget.onNoteHandled();
      });
    }
  }

  Future<void> _load() async {
    final perms = await Native.permissions();
    if (perms['phone'] == true) {
      final calls = await Native.recentCalls();
      if (mounted) setState(() => _calls = calls);
    } else if (mounted) {
      setState(() => _calls = null);
    }
    try {
      final s = await Api.instance.settings();
      if (mounted) setState(() => _missedReply = (s['app'] as Map?)?['missed_call_reply'] == true);
    } catch (_) {}
  }

  Future<void> _addNote(String number, String? name) async {
    final ctl = TextEditingController();
    final text = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.bg2,
      showDragHandle: true,
      builder: (c) => Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, MediaQuery.of(c).viewInsets.bottom + 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('What was the call about?', style: Theme.of(c).textTheme.titleMedium),
          const SizedBox(height: 4),
          Text(name ?? number, style: const TextStyle(color: AppColors.muted)),
          const SizedBox(height: 12),
          TextField(controller: ctl, autofocus: true, minLines: 2, maxLines: 5, decoration: const InputDecoration(hintText: 'e.g. Wants a quote for an iPhone 15 screen, call back Sunday')),
          const SizedBox(height: 14),
          GradientButton(label: 'Save to customer memory', icon: Icons.bookmark_add_rounded, onPressed: () => Navigator.pop(c, ctl.text.trim())),
        ]),
      ),
    );
    if (text == null || text.isEmpty) return;
    try {
      await Api.instance.callNote(number, text, name: name);
      if (mounted) showInfo(context, 'Saved. The agent and your team will see it in that chat.');
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _runLab() async {
    setState(() {
      _labRunning = true;
      _lab = null;
    });
    await Native.requestPermissions(['microphone', 'phone']);
    final r = await Native.callLab();
    if (mounted) setState(() {
      _lab = r;
      _labRunning = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      bottom: false,
      child: RefreshIndicator(
        onRefresh: _load,
        child: ListView(padding: EdgeInsets.fromLTRB(16, 16, 16, bottomGap(context) + 16), children: [
          const GradientText('Calls', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700)),
          const SizedBox(height: 14),
          _missedCard(),
          const SizedBox(height: 14),
          _recentCard(),
          const SizedBox(height: 14),
          _labCard(),
        ]),
      ),
    );
  }

  Widget _missedCard() => Glass(
        glow: _missedReply == true ? AppColors.green : null,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            const Icon(Icons.phone_missed_rounded, color: AppColors.cyan),
            const SizedBox(width: 10),
            const Expanded(
              child: Row(children: [
                Text('Missed call', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
                Padding(padding: EdgeInsets.symmetric(horizontal: 6), child: Icon(Icons.arrow_forward_rounded, size: 18, color: AppColors.muted)),
                Text('WhatsApp', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
              ]),
            ),
            Switch(
              value: _missedReply == true,
              onChanged: _missedReply == null
                  ? null
                  : (v) async {
                      try {
                        final s = await Api.instance.settings();
                        await Api.instance.saveSetting('app', {...((s['app'] as Map?) ?? {}).cast<String, dynamic>(), 'missed_call_reply': v});
                        final prefs = await AppPrefs.load();
                        if (v && !prefs.missedCalls) {
                          prefs.missedCalls = true;
                          await prefs.save();
                        }
                        if (!mounted) return;
                        setState(() => _missedReply = v);
                        if (v) showInfo(context, 'On. Keep "Report missed calls" on in Settings so this phone tells the agent.');
                      } catch (e) {
                        if (mounted) showError(context, e);
                      }
                    },
            ),
          ]),
          const SizedBox(height: 6),
          const Text(
            'When nobody answers a call on this phone, the agent messages the caller on WhatsApp right away and the call shows in their chat. Numbers need a country code; the same caller gets one message per 12 hours.',
            style: TextStyle(color: AppColors.muted, fontSize: 13),
          ),
        ]),
      );

  Widget _recentCard() {
    final calls = _calls;
    return Glass(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Row(children: [
          Icon(Icons.history_rounded, color: AppColors.violet),
          SizedBox(width: 10),
          Text('Recent calls', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
        ]),
        const SizedBox(height: 4),
        const Text('Tap a call to add a note to that customer.', style: TextStyle(color: AppColors.muted, fontSize: 13)),
        const SizedBox(height: 8),
        if (calls == null)
          TextButton.icon(
            onPressed: () async {
              await Native.requestPermissions(['phone']);
              _load();
            },
            icon: const Icon(Icons.lock_open_rounded),
            label: const Text('Allow access to calls'),
          )
        else if (calls.isEmpty)
          const Text('No calls yet.', style: TextStyle(color: AppColors.muted))
        else
          for (final c in calls.take(12))
            ListTile(
              contentPadding: EdgeInsets.zero,
              dense: true,
              leading: Icon(
                switch (c['type']) { 'missed' => Icons.call_missed_rounded, 'outgoing' => Icons.call_made_rounded, _ => Icons.call_received_rounded },
                color: c['type'] == 'missed' ? AppColors.red : AppColors.green,
              ),
              title: Text((c['name'] as String?)?.isNotEmpty == true ? c['name'] : c['number'] ?? 'Unknown'),
              subtitle: Text('${c['number'] ?? ''} · ${_when(c['date'])}${(c['duration'] ?? 0) > 0 ? ' · ${c['duration']}s' : ''}', style: const TextStyle(color: AppColors.muted)),
              trailing: const Icon(Icons.note_add_rounded, color: AppColors.muted),
              onTap: c['number'] == null ? null : () => _addNote(c['number'], c['name']),
            ),
      ]),
    );
  }

  static String _when(dynamic ms) {
    if (ms is! num) return '';
    final d = DateTime.fromMillisecondsSinceEpoch(ms.toInt());
    final now = DateTime.now();
    final hm = '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    return d.day == now.day && d.month == now.month ? hm : '${d.day}/${d.month} $hm';
  }

  Widget _labCard() => Glass(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Row(children: [
            Icon(Icons.science_rounded, color: AppColors.pink),
            SizedBox(width: 10),
            Text('Call lab', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
          ]),
          const SizedBox(height: 6),
          const Text(
            'Checks what this phone allows for future AI phone calls: root, and whether the app can hear and speak into a call. Run it once, then share the result.',
            style: TextStyle(color: AppColors.muted, fontSize: 13),
          ),
          const SizedBox(height: 12),
          GradientButton(label: _labRunning ? 'Checking…' : 'Run checks', icon: Icons.play_arrow_rounded, busy: _labRunning, onPressed: _runLab),
          if (_lab != null) ...[
            const SizedBox(height: 12),
            for (final r in _lab!)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Icon(
                    switch (r['status']) { 'ok' => Icons.check_circle_rounded, 'warn' => Icons.warning_rounded, _ => Icons.cancel_rounded },
                    size: 18,
                    color: switch (r['status']) { 'ok' => AppColors.green, 'warn' => AppColors.amber, _ => AppColors.red },
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(r['name'] ?? '', style: const TextStyle(fontWeight: FontWeight.w600)),
                      Text(r['detail'] ?? '', style: const TextStyle(color: AppColors.muted, fontSize: 12)),
                    ]),
                  ),
                ]),
              ),
          ],
        ]),
      );
}
