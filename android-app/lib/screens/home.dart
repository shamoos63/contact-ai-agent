import 'package:flutter/material.dart';

import '../api.dart';
import '../native.dart';
import '../theme.dart';
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

  // Opened from an "add a call note" notification: go to Calls with that number.
  Future<void> _checkCallNote() async {
    final n = await Native.pendingCallNote();
    if (n != null && mounted) setState(() {
      _noteFor = n;
      _tab = 2;
    });
  }

  Future<void> _startBackground() async {
    final api = Api.instance;
    final prefs = await AppPrefs.load();
    // The wake phrase needs the app open to start the microphone service (Android's rule).
    if (prefs.wake) await prefs.applyWake();
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
        destinations: const [
          NavigationDestination(icon: Icon(Icons.blur_on_rounded), label: 'Agent'),
          NavigationDestination(icon: Icon(Icons.forum_rounded), label: 'Inbox'),
          NavigationDestination(icon: Icon(Icons.call_rounded), label: 'Calls'),
          NavigationDestination(icon: Icon(Icons.tune_rounded), label: 'Settings'),
        ],
      ),
    );
  }
}
