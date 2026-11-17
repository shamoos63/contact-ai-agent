import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api.dart';
import '../native.dart';
import '../theme.dart';

/// What this phone does in the background.
class AppPrefs {
  AppPrefs({required this.background, required this.missedCalls, required this.callNotes});
  bool background;
  bool missedCalls;
  bool callNotes;

  static Future<AppPrefs> load() async {
    final p = await SharedPreferences.getInstance();
    return AppPrefs(
      background: p.getBool('bg') ?? true,
      missedCalls: p.getBool('missed_calls') ?? false,
      callNotes: p.getBool('call_notes') ?? false,
    );
  }

  Future<void> save() async {
    final p = await SharedPreferences.getInstance();
    await p.setBool('bg', background);
    await p.setBool('missed_calls', missedCalls);
    await p.setBool('call_notes', callNotes);
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

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final p = await AppPrefs.load();
    final r = await Native.serviceRunning();
    if (mounted) setState(() {
      _p = p;
      _running = r;
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
        const Center(child: Text('Agent companion · v0.1', style: TextStyle(color: AppColors.muted, fontSize: 12))),
      ]),
    );
  }
}
