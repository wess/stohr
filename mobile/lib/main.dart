import 'package:flutter/material.dart';
import 'api/index.dart';
import 'browser/index.dart';
import 'login/index.dart';
import 'theme/index.dart';

void main() {
  runApp(const StohrApp());
}

class StohrApp extends StatefulWidget {
  const StohrApp({super.key});
  @override
  State<StohrApp> createState() => _StohrAppState();
}

class _StohrAppState extends State<StohrApp> {
  @override
  void initState() {
    super.initState();
    session.bootstrap();
    session.addListener(_onSessionChange);
  }

  @override
  void dispose() {
    session.removeListener(_onSessionChange);
    super.dispose();
  }

  void _onSessionChange() => setState(() {});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Stohr',
      debugShowCheckedModeBanner: false,
      theme: lightTheme(),
      darkTheme: darkTheme(),
      themeMode: ThemeMode.system,
      home: !session.ready
          ? const _SplashScreen()
          : session.user == null
              ? const LoginScreen()
              : const BrowserScreen(),
    );
  }
}

class _SplashScreen extends StatelessWidget {
  const _SplashScreen();
  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(child: CircularProgressIndicator()),
    );
  }
}
