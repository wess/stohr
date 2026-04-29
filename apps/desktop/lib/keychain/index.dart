import 'dart:convert';
import 'dart:io';
import 'package:path_provider/path_provider.dart';

const _service = 'io.stohr.stohrshot';

/// Native-Keychain wrapper for unsigned macOS dev builds. We shell out to the
/// system `security(1)` CLI rather than using `flutter_secure_storage`,
/// because the latter requires `keychain-access-groups` in the app's
/// entitlements — which in turn forces development-certificate signing.
/// The CLI runs as the user, so it just works.
///
/// On non-macOS desktops we fall back to a `0600`-mode JSON file under the
/// app-support directory (until we wire libsecret / DPAPI). That's good
/// enough for a dev/personal-use menu-bar utility.

bool get _isMac => Platform.isMacOS;

Future<File> _fallbackFile() async {
  final dir = await getApplicationSupportDirectory();
  await dir.create(recursive: true);
  return File('${dir.path}/secrets.json');
}

Future<Map<String, String>> _readFallback() async {
  final f = await _fallbackFile();
  if (!await f.exists()) return {};
  try {
    final raw = await f.readAsString();
    final j = jsonDecode(raw) as Map<String, dynamic>;
    return j.map((k, v) => MapEntry(k, v as String));
  } catch (_) {
    return {};
  }
}

Future<void> _writeFallback(Map<String, String> map) async {
  final f = await _fallbackFile();
  await f.writeAsString(jsonEncode(map));
  if (!Platform.isWindows) {
    await Process.run('chmod', ['600', f.path]);
  }
}

Future<void> setSecret(String key, String value) async {
  if (_isMac) {
    // -U updates if already present; -s service, -a account, -w secret value.
    final res = await Process.run(
      '/usr/bin/security',
      ['add-generic-password', '-U', '-s', _service, '-a', key, '-w', value],
    );
    if (res.exitCode != 0) {
      throw StateError('security add-generic-password failed: ${res.stderr}');
    }
    return;
  }
  final map = await _readFallback();
  map[key] = value;
  await _writeFallback(map);
}

Future<String?> getSecret(String key) async {
  if (_isMac) {
    final res = await Process.run(
      '/usr/bin/security',
      ['find-generic-password', '-s', _service, '-a', key, '-w'],
    );
    if (res.exitCode != 0) return null;
    final out = (res.stdout as String).trim();
    return out.isEmpty ? null : out;
  }
  final map = await _readFallback();
  return map[key];
}

Future<void> deleteSecret(String key) async {
  if (_isMac) {
    await Process.run(
      '/usr/bin/security',
      ['delete-generic-password', '-s', _service, '-a', key],
    );
    return;
  }
  final map = await _readFallback();
  map.remove(key);
  await _writeFallback(map);
}
