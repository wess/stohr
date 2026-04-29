import 'package:flutter/material.dart';
import 'package:window_manager/window_manager.dart';
import 'hotkey/index.dart';
import 'session/index.dart';
import 'settings/index.dart';
import 'tray/index.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();

  // Menu-bar app: window starts hidden. Tray menu opens it on demand.
  const windowOpts = WindowOptions(
    size: Size(440, 600),
    center: true,
    skipTaskbar: true,
    title: 'Stohr',
    titleBarStyle: TitleBarStyle.normal,
  );
  await windowManager.waitUntilReadyToShow(windowOpts, () async {
    await windowManager.setPreventClose(true);
    await windowManager.hide();
  });

  final session = await Session.bootstrap();
  runApp(StohrshotApp(session: session));
}

class StohrshotApp extends StatefulWidget {
  final Session session;
  const StohrshotApp({super.key, required this.session});
  @override
  State<StohrshotApp> createState() => _StohrshotAppState();
}

class _StohrshotAppState extends State<StohrshotApp> with WindowListener {
  late final TrayController _tray;
  late final HotkeyController _hotkey;
  final _scaffoldKey = GlobalKey<ScaffoldMessengerState>();

  void _toast(String message) {
    _scaffoldKey.currentState?.showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _showWindow() async {
    await windowManager.show();
    await windowManager.focus();
  }

  @override
  void initState() {
    super.initState();
    windowManager.addListener(this);
    widget.session.addListener(_onSessionChange);
    _tray = TrayController(
      session: widget.session,
      onShowWindow: () { _showWindow(); },
      onError: _toast,
      onInfo: _toast,
    );
    _hotkey = HotkeyController(
      session: widget.session,
      onCapture: (mode) async {
        final result = await widget.session.capture(mode);
        if (result == null && widget.session.error != null) {
          _toast(widget.session.error!);
        } else if (result != null) {
          _toast('Link copied: ${result.shareUrl}');
        }
      },
    );
    Future.microtask(() async {
      await _tray.init();
      await _hotkey.init();
    });
  }

  bool _previouslySignedIn = false;
  void _onSessionChange() {
    final s = widget.session;
    if (s.isSignedIn && !_previouslySignedIn) {
      _previouslySignedIn = true;
      _toast('Signed in as @${s.user!.username}');
    } else if (!s.isSignedIn && _previouslySignedIn) {
      _previouslySignedIn = false;
    }
  }

  @override
  void dispose() {
    windowManager.removeListener(this);
    widget.session.removeListener(_onSessionChange);
    _tray.dispose();
    _hotkey.dispose();
    super.dispose();
  }

  @override
  void onWindowClose() async {
    // Closing the window just hides it; the menu-bar item stays alive.
    final isPrevented = await windowManager.isPreventClose();
    if (isPrevented) await windowManager.hide();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Stohr',
      debugShowCheckedModeBanner: false,
      scaffoldMessengerKey: _scaffoldKey,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF1F7AFF)),
      ),
      darkTheme: ThemeData(
        useMaterial3: true,
        brightness: Brightness.dark,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF1F7AFF),
          brightness: Brightness.dark,
        ),
      ),
      themeMode: ThemeMode.system,
      home: SettingsScreen(session: widget.session),
    );
  }
}
