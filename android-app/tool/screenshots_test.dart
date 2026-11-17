// Renders the app's main screens with sample data into docs/app-screenshots/.
// Run: flutter test tool/screenshots_test.dart   (not part of the normal test run)
import 'dart:io';
import 'dart:ui' as ui;

import 'package:agent_companion/api.dart';
import 'package:agent_companion/screens/home.dart';
import 'package:agent_companion/screens/inbox.dart';
import 'package:agent_companion/screens/setup.dart';
import 'package:agent_companion/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

const outDir = '../docs/app-screenshots';
const flutterFonts = String.fromEnvironment('FLUTTER_FONTS');

DateTime ago(Duration d) => DateTime.now().subtract(d);
String iso(DateTime d) => d.toUtc().toIso8601String();

Map<String, dynamic> msg(int id, String dir, String text, Duration age, {Map<String, dynamic> meta = const {}, String sender = 'customer'}) =>
    {'id': id, 'direction': dir, 'sender': dir == 'out' ? 'ai' : sender, 'text': text, 'meta': meta, 'created_at': iso(ago(age))};

/// The app's Api with sample answers instead of a server.
class SampleApi extends Api {
  SampleApi({this.emptyChat = false}) : super.forTest() {
    base = 'http://192.168.1.20:3000';
    cookie = 'cai_session=sample';
    ownerPhone = '+963944111222';
    ownerName = 'Hisham';
    company = 'TopTech';
  }
  final bool emptyChat;

  @override
  Future<List<Message>> chat({int after = 0}) async {
    if (emptyChat || after > 0) return [];
    return [
      msg(101, 'in', 'ذكرني بكرا الساعة 10 اتصل بالمورد', const Duration(minutes: 9)),
      msg(102, 'out', 'تم ضبط التذكير #12 بتاريخ الأربعاء، 18 تشرين الثاني، 10:00: اتصل بالمورد', const Duration(minutes: 9)),
      msg(103, 'in', "What's new today?", const Duration(minutes: 6)),
      msg(104, 'out', 'Today so far: 14 new chats, 3 passed to the sales team, 1 complaint answered.\nStill to do: call the supplier tomorrow at 10:00.', const Duration(minutes: 6)),
      msg(105, 'in', 'tell Mona her order is ready to pick up', const Duration(minutes: 1), meta: {'audio': 'v.m4a', 'voice': true, 'duration': 3}),
      msg(106, 'out', 'WhatsApp to Mona (+971 50 777 0000) now:\n\nHi Mona, your order is ready to pick up at TopTech. See you soon!\n\nReply "yes" to send or "no" to cancel.',
          const Duration(seconds: 40)),
    ].map(Message.fromJson).toList();
  }

  @override
  Future<List<Conversation>> conversations({String? q}) async {
    final rows = [
      ('Mona Khalil', 'whatsapp', '+971507770000', 'Is my iPhone 15 ready? I can come after 5', 2, 3, true),
      ('Sami', 'whatsapp', '+971501234567', 'بدي سعر تصليح شاشة iPhone 15', 1, 12, true),
      ('@ahmad_dxb', 'telegram', '@ahmad_dxb', 'Thanks! See you tomorrow', 0, 35, true),
      ('Nour Haddad', 'email', 'nour@example.com', 'Invoice for October', 0, 80, false),
      ('Layla', 'instagram', '@layla.style', 'هل عندكم iPad مستعمل؟', 1, 140, true),
      ('Rami Saleh', 'whatsapp', '+963944333444', 'Voice note: about the delivery', 0, 300, true),
      ('Omar', 'facebook', 'Omar Ali', 'What are your opening hours?', 0, 900, true),
    ];
    var id = 1;
    return rows
        .map((r) => Conversation.fromJson({
              'id': id++, 'contact_name': r.$1, 'channel': r.$2, 'contact_handle': r.$3, 'last_message': r.$4,
              'unread': r.$5, 'last_message_at': iso(ago(Duration(minutes: r.$6))), 'auto_reply': r.$7 ? 1 : 0, 'meta': {},
            }))
        .toList();
  }

  @override
  Future<(Conversation, List<Message>)> conversation(int id) async {
    final c = (await conversations()).first;
    return (
      c,
      [
        msg(1, 'in', 'Hi, I left my iPhone 15 for a screen repair yesterday', const Duration(minutes: 30)),
        msg(2, 'out', 'Hi Mona! Let me check that for you. Your repair (iPhone 15 screen) is done and ready to pick up.', const Duration(minutes: 29)),
        msg(3, 'note', 'Handed off to Maintenance: screen repair pickup', const Duration(minutes: 29)),
        msg(4, 'in', 'Great! How much is it?', const Duration(minutes: 5)),
        msg(5, 'out', 'The screen repair is 450 AED, including a 3-month warranty. You can pay by card or cash when you pick it up.', const Duration(minutes: 5)),
        msg(6, 'in', 'Is my iPhone 15 ready? I can come after 5', const Duration(minutes: 3)),
      ].map(Message.fromJson).toList(),
    );
  }

  @override
  Future<Map<String, dynamic>> settings() async => {
        'app': {'missed_call_reply': true},
      };

  @override
  Future<OwnersInfo> owners() async => OwnersInfo(true, [Owner('Hisham', '+963944111222')]);
}

Future<void> loadFonts() async {
  Future<void> family(String name, List<String> files) async {
    final loader = FontLoader(name);
    for (final f in files) {
      final file = File(f);
      if (file.existsSync()) loader.addFont(Future.value(ByteData.sublistView(file.readAsBytesSync())));
    }
    await loader.load();
  }

  await family('Roboto', [for (final w in ['Regular', 'Medium', 'Bold']) '$flutterFonts/Roboto-$w.ttf']);
  await family('MaterialIcons', ['$flutterFonts/MaterialIcons-Regular.otf']);
  await family('SFArabic', ['/System/Library/Fonts/SFArabic.ttf']);
}

ThemeData screenshotTheme() {
  final t = buildTheme();
  return t.copyWith(
    textTheme: t.textTheme.apply(fontFamily: 'Roboto', fontFamilyFallback: const ['SFArabic']),
    primaryTextTheme: t.primaryTextTheme.apply(fontFamily: 'Roboto', fontFamilyFallback: const ['SFArabic']),
  );
}

void mockNative() {
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel('agent/native'), (call) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    switch (call.method) {
      case 'permissions':
        return {'microphone': true, 'camera': true, 'phone': true, 'notifications': true};
      case 'serviceRunning':
        return true;
      case 'recentCalls':
        return [
          {'number': '+971501234567', 'name': 'Sami', 'type': 'missed', 'date': now - 8 * 60000, 'duration': 0},
          {'number': '+971507770000', 'name': 'Mona Khalil', 'type': 'incoming', 'date': now - 50 * 60000, 'duration': 142},
          {'number': '+963944333444', 'name': 'Rami Saleh', 'type': 'outgoing', 'date': now - 3 * 3600000, 'duration': 65},
        ];
      case 'callLab':
        return [
          {'name': 'Phone', 'status': 'ok', 'detail': 'Xiaomi MI 9T Pro · Android 15 (SDK 35)'},
          {'name': 'Root', 'status': 'ok', 'detail': 'su works: uid=0(root) gid=0(root)'},
          {'name': 'Privileged audio permission', 'status': 'warn', 'detail': 'Not granted yet. Install as a privileged system app (Magisk module).'},
          {'name': 'Hear the caller (VOICE_DOWNLINK)', 'status': 'fail', 'detail': 'Blocked for this app'},
        ];
      case 'pendingCallNote':
        return null;
      default:
        return null;
    }
  });
}

Future<void> shoot(WidgetTester tester, String name, Widget screen, {Future<void> Function()? then}) async {
  final key = GlobalKey();
  await tester.pumpWidget(RepaintBoundary(
    key: key,
    child: MaterialApp(debugShowCheckedModeBanner: false, theme: screenshotTheme(), home: screen),
  ));
  for (var i = 0; i < 12; i++) {
    await tester.pump(const Duration(milliseconds: 120));
  }
  if (then != null) {
    await then();
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 120));
    }
  }
  final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  await tester.runAsync(() async {
    final image = await boundary.toImage(pixelRatio: tester.view.devicePixelRatio);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    Directory(outDir).createSync(recursive: true);
    File('$outDir/$name.png').writeAsBytesSync(bytes!.buffer.asUint8List());
  });
  // Stop timers and animations before the next screen.
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(seconds: 1));
}

void main() {
  setUpAll(() async {
    await loadFonts();
    mockNative();
    SharedPreferences.setMockInitialValues({'bg': true, 'missed_calls': true, 'call_notes': true});
  });

  testWidgets('app screenshots', (tester) async {
    tester.view.physicalSize = const Size(1080, 2340);
    tester.view.devicePixelRatio = 2.625;
    addTearDown(tester.view.reset);

    Api.instance = SampleApi(emptyChat: true);
    await shoot(tester, '1-connect', SetupScreen(onDone: () {}));
    await shoot(tester, '2-agent-hello', HomeShell(onSignedOut: () {}));

    Api.instance = SampleApi();
    await shoot(tester, '3-agent-chat', HomeShell(onSignedOut: () {}));
    await shoot(tester, '4-inbox', HomeShell(onSignedOut: () {}), then: () => tester.tap(find.text('Inbox')));
    await shoot(tester, '5-customer-chat', const ConversationScreen(id: 1, title: 'Mona Khalil'));
    await shoot(tester, '6-calls', HomeShell(onSignedOut: () {}), then: () async {
      await tester.tap(find.text('Calls'));
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(find.text('Run checks'));
    });
    await shoot(tester, '7-settings', HomeShell(onSignedOut: () {}), then: () => tester.tap(find.text('Settings')));
  });
}
