import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';
import '../widgets/orb.dart';

/// First run: where the agent is, sign in, and which owner this phone belongs to.
class SetupScreen extends StatefulWidget {
  const SetupScreen({super.key, required this.onDone});
  final VoidCallback onDone;
  @override
  State<SetupScreen> createState() => _SetupScreenState();
}

class _SetupScreenState extends State<SetupScreen> {
  final _server = TextEditingController(text: Api.instance.base.isEmpty ? 'http://192.168.1.' : Api.instance.base);
  final _user = TextEditingController(text: 'admin');
  final _pass = TextEditingController();
  bool _busy = false;
  OwnersInfo? _owners;

  Future<void> _signIn() async {
    setState(() => _busy = true);
    try {
      await Api.instance.signIn(_server.text, _user.text.trim(), _pass.text);
      final info = await Api.instance.owners();
      if (info.owners.length == 1) {
        await Api.instance.chooseOwner(info.owners.first);
        widget.onDone();
        return;
      }
      setState(() => _owners = info);
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: AgentBackground(
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(24, 32, 24, 24),
            children: [
              const Center(child: AgentOrb(size: 170)),
              const SizedBox(height: 20),
              const Center(child: GradientText('Your AI agent', style: TextStyle(fontSize: 30, fontWeight: FontWeight.w700))),
              const SizedBox(height: 8),
              const Center(
                child: Text('Connect this phone to the agent running on your computer.',
                    textAlign: TextAlign.center, style: TextStyle(color: AppColors.muted)),
              ),
              const SizedBox(height: 28),
              if (_owners == null) ..._signInForm() else ..._ownerPicker(),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _signInForm() => [
        TextField(
          controller: _server,
          keyboardType: TextInputType.url,
          decoration: const InputDecoration(labelText: 'Agent address', prefixIcon: Icon(Icons.dns_rounded), helperText: 'The computer\'s address on your Wi-Fi, e.g. http://192.168.1.20:3000', helperMaxLines: 2),
        ),
        const SizedBox(height: 14),
        TextField(controller: _user, decoration: const InputDecoration(labelText: 'Username', prefixIcon: Icon(Icons.person_rounded))),
        const SizedBox(height: 14),
        TextField(
          controller: _pass,
          obscureText: true,
          onSubmitted: (_) => _signIn(),
          decoration: const InputDecoration(labelText: 'Password', prefixIcon: Icon(Icons.lock_rounded)),
        ),
        const SizedBox(height: 24),
        GradientButton(label: 'Connect', icon: Icons.bolt_rounded, busy: _busy, onPressed: _signIn),
        const SizedBox(height: 16),
        const Text('Same username and password as the dashboard.', textAlign: TextAlign.center, style: TextStyle(color: AppColors.muted, fontSize: 12)),
      ];

  List<Widget> _ownerPicker() {
    final info = _owners!;
    if (!info.enabled || info.owners.isEmpty) {
      return [
        Glass(
          glow: AppColors.amber,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Row(children: [Icon(Icons.info_rounded, color: AppColors.amber), SizedBox(width: 8), Text('One more step', style: TextStyle(fontWeight: FontWeight.w600))]),
            const SizedBox(height: 8),
            Text(!info.enabled
                ? 'Turn on the Assistant in the dashboard (Assistant page) and add your WhatsApp number as an owner. Then tap Check again.'
                : 'Add your WhatsApp number as an owner on the Assistant page in the dashboard. Then tap Check again.'),
          ]),
        ),
        const SizedBox(height: 20),
        GradientButton(label: 'Check again', icon: Icons.refresh_rounded, busy: _busy, onPressed: _signIn),
      ];
    }
    return [
      const Text('Who is this phone for?', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
      const SizedBox(height: 12),
      for (final o in info.owners)
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Glass(
            onTap: () async {
              await Api.instance.chooseOwner(o);
              widget.onDone();
            },
            child: Row(children: [
              CircleAvatar(backgroundColor: AppColors.violet.withValues(alpha: 0.3), child: Text(o.name.isEmpty ? '?' : o.name.characters.first.toUpperCase())),
              const SizedBox(width: 12),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(o.name.isEmpty ? 'Owner' : o.name, style: const TextStyle(fontWeight: FontWeight.w600)),
                Text(o.phone, style: const TextStyle(color: AppColors.muted)),
              ])),
              const Icon(Icons.chevron_right_rounded, color: AppColors.muted),
            ]),
          ),
        ),
    ];
  }
}
