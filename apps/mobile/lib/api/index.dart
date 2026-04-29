import 'dart:io' show Platform;
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:stohr/stohr.dart';

const _storage = FlutterSecureStorage();
const _tokenKey = 'stohr_token';
const _baseKey = 'stohr_base';

String _defaultBase() {
  if (kIsWeb) return 'http://localhost:3000';
  if (Platform.isAndroid) return 'http://10.0.2.2:3000';
  return 'http://localhost:3000';
}

bool _isLocalHost(String host) {
  final h = host.toLowerCase();
  if (h == 'localhost' || h == '127.0.0.1' || h == '0.0.0.0' || h == '10.0.2.2' || h == '::1') return true;
  if (RegExp(r'^192\.168\.').hasMatch(h)) return true;
  if (RegExp(r'^10\.').hasMatch(h)) return true;
  if (RegExp(r'^172\.(1[6-9]|2\d|3[01])\.').hasMatch(h)) return true;
  if (h.endsWith('.local')) return true;
  return false;
}

/// Normalize whatever the user typed (or whatever's in storage) into a sane
/// base URL:
/// - Missing scheme: infer http for localhost-y hosts, https otherwise.
/// - Stored https against a localhost-y host: downgrade to http (TLS won't
///   terminate locally — this is what triggers WRONG_VERSION_NUMBER).
/// - Strip trailing slashes.
String normalizeBaseUrl(String input) {
  var trimmed = input.trim();
  if (trimmed.isEmpty) return '';
  trimmed = trimmed.replaceAll(RegExp(r'/+$'), '');
  if (!trimmed.contains('://')) {
    final hostPart = trimmed.split('/').first;
    final host = hostPart.split(':').first;
    final scheme = _isLocalHost(host) ? 'http' : 'https';
    return '$scheme://$trimmed';
  }
  try {
    final uri = Uri.parse(trimmed);
    if (uri.scheme == 'https' && _isLocalHost(uri.host)) {
      return uri.replace(scheme: 'http').toString().replaceAll(RegExp(r'/+$'), '');
    }
  } catch (_) {
    // Fall through — let the SDK surface the error if the URL is truly invalid.
  }
  return trimmed;
}

StohrClient _client = StohrClient(baseUrl: _defaultBase());

class Session extends ChangeNotifier {
  User? user;
  String? baseUrl;
  bool ready = false;

  Future<void> bootstrap() async {
    final stored = await _storage.read(key: _baseKey);
    final token = await _storage.read(key: _tokenKey);
    final raw = stored ?? _defaultBase();
    final normalized = normalizeBaseUrl(raw);
    if (stored != null && stored != normalized) {
      // Repair stale stored URL (e.g. https://localhost from an older build).
      await _storage.write(key: _baseKey, value: normalized);
    }
    baseUrl = normalized;
    _client = StohrClient(baseUrl: normalized, token: token);
    if (token != null) {
      try {
        user = await _client.me();
      } catch (_) {
        await _storage.delete(key: _tokenKey);
        _client = StohrClient(baseUrl: normalized);
      }
    }
    ready = true;
    notifyListeners();
  }

  Future<void> setBase(String base) async {
    final clean = normalizeBaseUrl(base);
    baseUrl = clean;
    await _storage.write(key: _baseKey, value: clean);
    final token = await _storage.read(key: _tokenKey);
    _client = StohrClient(baseUrl: clean, token: token);
    notifyListeners();
  }

  /// Returns [User] on full sign-in or [MfaChallenge] if TOTP is required.
  Future<Object> login(String identity, String password) async {
    final res = await _client.login(identity, password);
    if (res is MfaChallenge) return res;
    final auth = res as AuthResult;
    user = auth.user;
    await _storage.write(key: _tokenKey, value: auth.token);
    notifyListeners();
    return auth.user;
  }

  Future<User> completeMfa({
    required String mfaToken,
    String? code,
    String? backupCode,
  }) async {
    final res = await _client.loginMfa(mfaToken: mfaToken, code: code, backupCode: backupCode);
    user = res.user;
    await _storage.write(key: _tokenKey, value: res.token);
    notifyListeners();
    return res.user;
  }

  Future<void> signOut() async {
    user = null;
    await _storage.delete(key: _tokenKey);
    _client = StohrClient(baseUrl: baseUrl ?? _defaultBase());
    notifyListeners();
  }
}

final session = Session();

StohrClient get api => _client;
