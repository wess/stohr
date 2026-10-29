import 'dart:io' show exit;

import 'package:flutter/services.dart' show Clipboard, ClipboardData;
import 'package:tray_manager/tray_manager.dart';

import '../capture/index.dart';
import '../session/index.dart';

class TrayController {
  final Session session;
  final void Function() onShowWindow;
  final void Function(String) onError;
  final void Function(String) onInfo;

  TrayIcon? _trayIcon;
  Menu? _menu;
  List<MenuItem> _items = [];
  ListenerId? _trayListener;

  TrayController({
    required this.session,
    required this.onShowWindow,
    required this.onError,
    required this.onInfo,
  });

  Future<void> init() async {
    final tray = TrayIcon.create();
    if (tray == null) throw StateError('Could not create the tray icon');
    tray.icon = ImageAsset.fromAsset('assets/icon.png');
    tray.isIconTemplate = true;
    tray.setTooltip('Stohr');
    tray.setContextMenuTrigger(ContextMenuTrigger.none);
    _trayListener = tray.addListener((event) {
      if (event is TrayIconClickedEvent || event is TrayIconRightClickedEvent) {
        tray.openContextMenu();
      }
    });
    tray.setVisible(true);
    _trayIcon = tray;
    session.addListener(_rebuildMenu);
    await _rebuildMenu();
  }

  Future<void> dispose() async {
    session.removeListener(_rebuildMenu);
    final tray = _trayIcon;
    final listener = _trayListener;
    if (tray != null && listener != null) tray.removeListener(listener);
    tray?.dispose();
    _menu?.dispose();
    for (final item in _items) {
      item.dispose();
    }
    _trayIcon = null;
    _menu = null;
    _items = [];
    _trayListener = null;
  }

  Future<void> _rebuildMenu() async {
    final signedIn = session.isSignedIn;
    final menu = Menu.create();
    if (menu == null) throw StateError('Could not create the tray menu');
    final items = <MenuItem>[];

    MenuItem add(String label, Future<void> Function() action) {
      final item = MenuItem.createWithLabelAndType(label, MenuItemType.normal);
      if (item == null) {
        throw StateError('Could not create the $label menu item');
      }
      item.addListener((event) async {
        if (event is MenuItemClickedEvent) await action();
      });
      menu.addItem(item);
      items.add(item);
      return item;
    }

    if (signedIn) {
      add('Capture region', () => _runCapture(CaptureMode.region));
      add('Capture window', () => _runCapture(CaptureMode.window));
      add('Capture full screen', () => _runCapture(CaptureMode.screen));
      menu.addSeparator();
      add('Recent captures…', () async => onShowWindow());
      menu.addSeparator();
      add('Sign out', () async {
        await session.signOut();
        onInfo('Signed out');
      });
    } else {
      add('Sign in…', () async => onShowWindow());
    }
    menu.addSeparator();
    add('Quit', () async {
      await dispose();
      exit(0);
    });

    _trayIcon?.setContextMenu(menu);
    final oldMenu = _menu;
    final oldItems = _items;
    _menu = menu;
    _items = items;
    oldMenu?.dispose();
    for (final item in oldItems) {
      item.dispose();
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
