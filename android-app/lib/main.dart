import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'api.dart';
import 'screens/home.dart';
import 'screens/setup.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    systemNavigationBarColor: AppColors.bg,
    statusBarIconBrightness: Brightness.light,
  ));
  await Api.instance.load();
  runApp(const AgentApp());
}

class AgentApp extends StatefulWidget {
  const AgentApp({super.key});
  @override
  State<AgentApp> createState() => _AgentAppState();
}

class _AgentAppState extends State<AgentApp> {
  bool get _ready => Api.instance.signedIn && Api.instance.ownerPhone != null;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Agent',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      home: _ready
          ? HomeShell(onSignedOut: () => setState(() {}))
          : SetupScreen(onDone: () => setState(() {})),
    );
  }
}
