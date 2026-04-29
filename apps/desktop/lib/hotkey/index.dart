import 'package:flutter/services.dart' show PhysicalKeyboardKey;
import 'package:hotkey_manager/hotkey_manager.dart';
import '../capture/index.dart';
import '../session/index.dart';

class HotkeyController {
  final Session session;
  final Future<void> Function(CaptureMode) onCapture;

  HotkeyController({required this.session, required this.onCapture});

  // Cmd+Shift+8 — picked to avoid colliding with macOS native Cmd+Shift+3/4/5.
  HotKey _binding() => HotKey(
        key: PhysicalKeyboardKey.digit8,
        modifiers: const [HotKeyModifier.meta, HotKeyModifier.shift],
        scope: HotKeyScope.system,
      );

  Future<void> init() async {
    await hotKeyManager.unregisterAll();
    await hotKeyManager.register(
      _binding(),
      keyDownHandler: (_) async {
        await onCapture(CaptureMode.region);
      },
    );
  }

  Future<void> dispose() async {
    await hotKeyManager.unregisterAll();
  }
}
