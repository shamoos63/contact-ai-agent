import 'package:agent_companion/api.dart';
import 'package:agent_companion/screens/setup.dart';
import 'package:agent_companion/theme.dart';
import 'package:agent_companion/widgets/orb.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('first run asks where the agent is and to sign in', (tester) async {
    await tester.pumpWidget(MaterialApp(theme: buildTheme(), home: SetupScreen(onDone: () {})));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Your AI agent'), findsOneWidget);
    expect(find.text('Connect'), findsOneWidget);
    expect(find.byType(AgentOrb), findsOneWidget);
  });

  test('server addresses get http and the dashboard port', () {
    expect(Api.normalizeServer('192.168.1.20'), 'http://192.168.1.20:3000');
    expect(Api.normalizeServer('http://192.168.1.20:3000/'), 'http://192.168.1.20:3000');
    expect(Api.normalizeServer('https://ai.example.com'), 'https://ai.example.com');
  });

  test('photo descriptions are kept out of the visible text', () {
    final m = Message.fromJson({'id': 1, 'direction': 'in', 'text': 'save this\n\n[Photo: A business card. Text: Nour +971 55]', 'meta': {}, 'created_at': '2026-11-17 00:00:00'});
    expect(m.visibleText, 'save this');
    expect(m.photoDescription, 'A business card. Text: Nour +971 55');
  });
}
