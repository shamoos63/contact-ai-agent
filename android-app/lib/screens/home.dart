import 'package:flutter/material.dart';

import '../api.dart';
import '../native.dart';
import '../theme.dart';
import 'approvals.dart';
import 'assistant.dart';
import 'calls.dart';
import 'inbox.dart';
import 'settings.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key, required this.onSignedOut});
  final VoidCallback onSignedOut;
  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> with WidgetsBindingObserver {
  int _tab = 0;
  String? _noteFor;
  int _approvals = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _startBackground();
    _checkCallNote();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _checkCallNote();
  }

  // Opened from a notification: "add a call note" goes to Calls, "needs your OK" to Approvals.
  Future<void> _checkCallNote() async {
    final n = await Native.pendingCallNote();
    if (n != null && mounted) setState(() {
      _noteFor = n;
      _tab = 3;
    });
    if (await Native.pendingOpen() == 'approvals' && mounted) setState(() => _tab = 1);
  }

  Future<void> _startBackground() async {
    final api = Api.instance;
    final prefs = await AppPrefs.load();
    // The wake phrase needs the app open to start the microphone service (Android's rule).
    if (prefs.wake) {
      // If "Hey …" failed to start last time, it was switched off on the phone: keep it off (the
      // reason shows in Settings) instead of trying again on every launch.
      final w = await Native.wakeStatus();
      if (w['state'] == 'error' && w['enabled'] == false) {
        prefs.wake = false;
        await prefs.save();
      } else {
        await prefs.applyWake();
      }
    }
    if (!prefs.background) return;
    await Native.requestPermissions(['notifications', if (prefs.missedCalls || prefs.callNotes) 'phone']);
    await Native.startService(server: api.base, cookie: api.cookie!, owner: api.ownerPhone, missedCalls: prefs.missedCalls, callNotes: prefs.callNotes);
  }

  void _signedOut() {
    Native.stopService();
    widget.onSignedOut();
  }

  @override
  Widget build(BuildContext context) {
    final pages = [
      AssistantScreen(onSignedOut: _signedOut),
      ApprovalsScreen(onCount: (n) {
        if (n != _approvals && mounted) setState(() => _approvals = n);
      }),
      InboxScreen(onSignedOut: _signedOut),
      CallsScreen(noteFor: _noteFor, onNoteHandled: () => _noteFor = null),
      SettingsScreen(onSignedOut: _signedOut, onChanged: _startBackground),
    ];
    return Scaffold(
      extendBody: true,
      body: AgentBackground(child: IndexedStack(index: _tab, children: pages)),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        height: 68,
        destinations: [
          const NavigationDestination(icon: Icon(Icons.blur_on_rounded), label: 'Agent'),
          NavigationDestination(
            icon: Badge(isLabelVisible: _approvals > 0, label: Text('$_approvals'), child: const Icon(Icons.task_alt_rounded)),
            label: 'Approvals',
          ),
          const NavigationDestination(icon: Icon(Icons.forum_rounded), label: 'Inbox'),
          const NavigationDestination(icon: Icon(Icons.call_rounded), label: 'Calls'),
          const NavigationDestination(icon: Icon(Icons.tune_rounded), label: 'Settings'),
        ],
      ),
    );
  }
}
