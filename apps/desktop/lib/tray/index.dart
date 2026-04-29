import 'dart:io' show exit;
import 'package:flutter/services.dart' show Clipboard, ClipboardData;
import 'package:tray_manager/tray_manager.dart';
import '../capture/index.dart';
import '../session/index.dart';

class TrayController with TrayListener {
  final Session session;
  final void Function() onShowWindow;
  final void Function(String) onError;
  final void Function(String) onInfo;

  TrayController({
    required this.session,
    required this.onShowWindow,
    required this.onError,
    required this.onInfo,
  });

  Future<void> init() async {
    await trayManager.setIcon('assets/icon.png', isTemplate: true);
    await trayManager.setToolTip('Stohr');
    trayManager.addListener(this);
    session.addListener(_rebuildMenu);
    await _rebuildMenu();
  }

  Future<void> dispose() async {
    trayManager.removeListener(this);
    session.removeListener(_rebuildMenu);
    await trayManager.destroy();
  }

  Future<void> _rebuildMenu() async {
    final signedIn = session.isSignedIn;
    final items = <MenuItem>[
      if (signedIn) ...[
        MenuItem(key: 'capture-region', label: 'Capture region'),
        MenuItem(key: 'capture-window', label: 'Capture window'),
        MenuItem(key: 'capture-screen', label: 'Capture full screen'),
        MenuItem.separator(),
        MenuItem(key: 'show', label: 'Recent captures…'),
        MenuItem.separator(),
        MenuItem(key: 'signout', label: 'Sign out'),
      ] else ...[
        MenuItem(key: 'show', label: 'Sign in…'),
      ],
      MenuItem.separator(),
      MenuItem(key: 'quit', label: 'Quit'),
    ];
    await trayManager.setContextMenu(Menu(items: items));
  }

  @override
  void onTrayIconRightMouseDown() => trayManager.popUpContextMenu();

  @override
  void onTrayIconMouseDown() => trayManager.popUpContextMenu();

  @override
  Future<void> onTrayMenuItemClick(MenuItem menuItem) async {
    switch (menuItem.key) {
      case 'capture-region':
        await _runCapture(CaptureMode.region);
        break;
      case 'capture-window':
        await _runCapture(CaptureMode.window);
        break;
      case 'capture-screen':
        await _runCapture(CaptureMode.screen);
        break;
      case 'show':
        onShowWindow();
        break;
      case 'signout':
        await session.signOut();
        onInfo('Signed out');
        break;
      case 'quit':
        await trayManager.destroy();
        exit(0);
    }
  }

  Future<void> _runCapture(CaptureMode mode) async {
    final result = await session.capture(mode);
    if (result == null) {
      if (session.error != null) onError(session.error!);
      return;
    }
    await Clipboard.setData(ClipboardData(text: result.shareUrl));
    onInfo('Link copied: ${result.shareUrl}');
  }
}
