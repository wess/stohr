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

StohrClient _client = StohrClient(baseUrl: _defaultBase());

class Session extends ChangeNotifier {
  User? user;
  String? baseUrl;
  bool ready = false;

  Future<void> bootstrap() async {
    final base = await _storage.read(key: _baseKey);
    final token = await _storage.read(key: _tokenKey);
    baseUrl = base ?? _defaultBase();
    _client = StohrClient(baseUrl: baseUrl, token: token);
    if (token != null) {
      try {
        user = await _client.me();
      } catch (_) {
        await _storage.delete(key: _tokenKey);
        _client = StohrClient(baseUrl: baseUrl);
      }
    }
    ready = true;
    notifyListeners();
  }

  Future<void> setBase(String base) async {
    final clean = base.replaceAll(RegExp(r'/$'), '');
    baseUrl = clean;
    await _storage.write(key: _baseKey, value: clean);
    final token = await _storage.read(key: _tokenKey);
    _client = StohrClient(baseUrl: clean, token: token);
    notifyListeners();
  }

  Future<User> login(String identity, String password) async {
    final res = await _client.login(identity, password);
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
