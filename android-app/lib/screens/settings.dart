import 'dart:async';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api.dart';
import '../native.dart';
import '../theme.dart';

/// What this phone does in the background.
class AppPrefs {
  AppPrefs({
    required this.background,
    required this.missedCalls,
    required this.callNotes,
    this.wake = false,
    this.wakeName = 'Jarvis',
    this.wakeSpeak = true,
    this.wakeCharging = false,
  });
  bool background;
  bool missedCalls;
  bool callNotes;
  bool wake; // "Hey <name>" wake phrase
  String wakeName;
  bool wakeSpeak;
  bool wakeCharging;

  static Future<AppPrefs> load() async {
    final p = await SharedPreferences.getInstance();
    return AppPrefs(
      background: p.getBool('bg') ?? true,
      missedCalls: p.getBool('missed_calls') ?? false,
      callNotes: p.getBool('call_notes') ?? false,
      wake: p.getBool('wake') ?? false,
      wakeName: p.getString('wake_name') ?? 'Jarvis',
      wakeSpeak: p.getBool('wake_speak') ?? true,
      wakeCharging: p.getBool('wake_charging') ?? false,
    );
  }

  Future<void> save() async {
    final p = await SharedPreferences.getInstance();
    await p.setBool('bg', background);
    await p.setBool('missed_calls', missedCalls);
    await p.setBool('call_notes', callNotes);
    await p.setBool('wake', wake);
    await p.setString('wake_name', wakeName);
    await p.setBool('wake_speak', wakeSpeak);
    await p.setBool('wake_charging', wakeCharging);
  }

  /// Start or stop the wake phrase listener to match these settings.
  Future<void> applyWake() async {
    if (wake) {
      await Native.requestPermissions(['microphone', 'notifications']);
      await Native.wakeStart(name: wakeName, speak: wakeSpeak, onlyCharging: wakeCharging);
    } else {
      await Native.wakeStop();
    }
  }
}

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key, required this.onSignedOut, required this.onChanged});
  final VoidCallback onSignedOut;
  final Future<void> Function() onChanged;
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  AppPrefs? _p;
  bool _running = false;
  Map<String, dynamic> _wake = const {'state': 'off'};
  Timer? _wakePoll;
  final _wakeName = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
    _wakePoll = Timer.periodic(const Duration(seconds: 2), (_) async {
      final w = await Native.wakeStatus();
      if (mounted) setState(() => _wake = w);
    });
  }

  @override
  void dispose() {
    _wakePoll?.cancel();
    _wakeName.dispose();
    super.dispose();
  }

  Future<void> _setWake(void Function(AppPrefs) change) async {
    final p = _p!;
    change(p);
    await p.save();
    await p.applyWake();
    await _load();
  }

  String get _wakeLine {
    final d = _wake['detail']?.toString();
    return switch (_wake['state']) {
      'downloading' => 'Getting the listening model (once, about 40 MB)… ${d ?? 0}%',
      'listening' => 'Listening for "Hey ${_p?.wakeName ?? ''}"',
      'recording' => 'I\'m listening…',
      'thinking' => 'Thinking…',
      'speaking' => 'Speaking…',
      'paused' => d ?? 'Paused',
      'error' => d ?? 'Something went wrong',
      _ => 'Off',
    };
  }

  Future<void> _load() async {
    final p = await AppPrefs.load();
    final r = await Native.serviceRunning();
    if (mounted) setState(() {
      _p = p;
      _running = r;
      if (_wakeName.text.isEmpty) _wakeName.text = p.wakeName;
    });
  }

  Future<void> _set(void Function(AppPrefs) change) async {
    final p = _p!;
    change(p);
    await p.save();
    if (p.background) {
      await widget.onChanged();
    } else {
      await Native.stopService();
    }
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final p = _p;
    final api = Api.instance;
    return SafeArea(
      bottom: false,
      child: ListView(padding: const EdgeInsets.fromLTRB(16, 16, 16, 100), children: [
        const GradientText('Settings', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700)),
        const SizedBox(height: 14),
        Glass(
          child: Row(children: [
            CircleAvatar(radius: 24, backgroundColor: AppColors.violet.withValues(alpha: 0.3), child: Text(api.ownerName.isEmpty ? '?' : api.ownerName.characters.first.toUpperCase(), style: const TextStyle(fontSize: 20))),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(api.ownerName.isEmpty ? 'Owner' : api.ownerName, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
                Text(api.ownerPhone ?? '', style: const TextStyle(color: AppColors.muted)),
                Text(api.base, style: const TextStyle(color: AppColors.muted, fontSize: 12)),
              ]),
            ),
          ]),
        ),
        const SizedBox(height: 14),
        if (p != null)
          Glass(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
            child: Column(children: [
              SwitchListTile(
                value: p.background,
                onChanged: (v) => _set((x) => x.background = v),
                title: const Text('Notifications'),
                subtitle: Text(_running ? 'Running · alerts, questions and drafts pop up on this phone' : 'Alerts, questions and drafts pop up on this phone', style: const TextStyle(color: AppColors.muted)),
                secondary: const Icon(Icons.notifications_active_rounded, color: AppColors.cyan),
              ),
              SwitchListTile(
                value: p.missedCalls,
                onChanged: p.background ? (v) => _set((x) => x.missedCalls = v) : null,
                title: const Text('Report missed calls'),
                subtitle: const Text('Tell the agent about calls nobody answered (it messages the caller only if that is on in the Calls tab)', style: TextStyle(color: AppColors.muted)),
                secondary: const Icon(Icons.phone_missed_rounded, color: AppColors.violet),
              ),
              SwitchListTile(
                value: p.callNotes,
                onChanged: p.background ? (v) => _set((x) => x.callNotes = v) : null,
                title: const Text('Ask for a note after calls'),
                subtitle: const Text('A notification after each call: "What was it about?"', style: TextStyle(color: AppColors.muted)),
                secondary: const Icon(Icons.edit_note_rounded, color: AppColors.pink),
              ),
            ]),
          ),
        const SizedBox(height: 14),
        if (p != null) _wakeCard(p),
        const SizedBox(height: 14),
        Glass(
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
          child: Column(children: [
            ListTile(
              leading: const Icon(Icons.swap_horiz_rounded),
              title: const Text('Switch owner'),
              onTap: () async {
                try {
                  final info = await api.owners();
                  if (!context.mounted) return;
                  final o = await showModalBottomSheet<Owner>(
                    context: context,
                    backgroundColor: AppColors.bg2,
                    showDragHandle: true,
                    builder: (c) => SafeArea(
                      child: Column(mainAxisSize: MainAxisSize.min, children: [
                        for (final o in info.owners) ListTile(title: Text(o.name.isEmpty ? o.phone : o.name), subtitle: Text(o.phone), onTap: () => Navigator.pop(c, o)),
                      ]),
                    ),
                  );
                  if (o != null) {
                    await api.chooseOwner(o);
                    await widget.onChanged();
                    setState(() {});
                  }
                } catch (e) {
                  if (context.mounted) showError(context, e);
                }
              },
            ),
            ListTile(
              leading: const Icon(Icons.logout_rounded, color: AppColors.red),
              title: const Text('Sign out', style: TextStyle(color: AppColors.red)),
              onTap: () async {
                await api.signOut();
                widget.onSignedOut();
              },
            ),
          ]),
        ),
        const SizedBox(height: 18),
        const Center(child: Text('Agent companion · v0.2', style: TextStyle(color: AppColors.muted, fontSize: 12))),
      ]),
    );
  }

  Widget _wakeCard(AppPrefs p) {
    final active = p.wake && _wake['state'] != 'off' && _wake['state'] != 'error';
    return Glass(
      glow: active ? AppColors.cyan : null,
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SwitchListTile(
          value: p.wake,
          onChanged: (v) => _setWake((x) => x.wake = v),
          title: Text('Hey ${p.wakeName}'),
          subtitle: Text(p.wake ? _wakeLine : 'Say "Hey ${p.wakeName}" and give a command, even with the app closed',
              style: TextStyle(color: _wake['state'] == 'error' ? AppColors.red : AppColors.muted)),
          secondary: const Icon(Icons.record_voice_over_rounded, color: AppColors.cyan),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
          child: TextField(
            controller: _wakeName,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(
              labelText: "Agent's name",
              helperText: 'An English word that\'s easy to hear, e.g. Jarvis, Nova, Max',
              isDense: true,
            ),
            onSubmitted: (v) {
              final name = v.trim().replaceAll(RegExp(r'[^A-Za-z ]'), '');
              if (name.isEmpty) return;
              _wakeName.text = name;
              _setWake((x) => x.wakeName = name);
            },
          ),
        ),
        SwitchListTile(
          value: p.wakeSpeak,
          onChanged: (v) => _setWake((x) => x.wakeSpeak = v),
          title: const Text('Speak the answer out loud'),
          secondary: const Icon(Icons.volume_up_rounded, color: AppColors.violet),
        ),
        SwitchListTile(
          value: p.wakeCharging,
          onChanged: (v) => _setWake((x) => x.wakeCharging = v),
          title: const Text('Only while charging'),
          subtitle: const Text('Saves battery: listens only when the phone is plugged in', style: TextStyle(color: AppColors.muted)),
          secondary: const Icon(Icons.battery_charging_full_rounded, color: AppColors.green),
        ),
        const Padding(
          padding: EdgeInsets.fromLTRB(16, 0, 16, 12),
          child: Text(
            'Listening happens on the phone, offline. Nothing is sent until it hears "Hey" + the name. Android shows the microphone icon while it listens.',
            style: TextStyle(color: AppColors.muted, fontSize: 12),
          ),
        ),
      ]),
    );
  }
}
