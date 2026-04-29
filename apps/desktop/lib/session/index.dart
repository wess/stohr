import 'package:flutter/foundation.dart';
import 'package:stohr/stohr.dart' show User;
import '../auth/index.dart' as auth;
import '../api/index.dart' as api;
import '../capture/index.dart';
import '../config/index.dart';

class Session extends ChangeNotifier {
  StohrConfig _config;
  User? _user;
  bool _busy = false;
  String? _error;
  /// Set when /login returned an MFA challenge — UI prompts for the 6-digit
  /// code (or backup code) and the caller resolves with [completeMfa].
  String? _mfaToken;

  Session._(this._config);

  StohrConfig get config => _config;
  User? get user => _user;
  bool get isSignedIn => _user != null;
  bool get busy => _busy;
  String? get error => _error;
  String? get mfaToken => _mfaToken;
  bool get awaitingMfa => _mfaToken != null;

  static Future<Session> bootstrap() async {
    final cfg = await loadConfig();
    final s = Session._(cfg);
    final token = await auth.loadToken();
    if (token != null) {
      try {
        s._user = await api.currentUser(cfg);
      } catch (_) {
        await auth.clearToken();
      }
    }
    return s;
  }

  Future<void> setServerUrl(String url) async {
    _config = _config.copyWith(serverUrl: url.trim());
    await saveConfig(_config);
    notifyListeners();
  }

  Future<void> signOut() async {
    await auth.clearToken();
    _user = null;
    _mfaToken = null;
    notifyListeners();
  }

  Future<bool> signIn(String identity, String password) async {
    _busy = true;
    _error = null;
    _mfaToken = null;
    notifyListeners();
    try {
      final outcome = await auth.signIn(
        config: _config,
        identity: identity,
        password: password,
      );
      if (outcome is auth.MfaRequired) {
        _mfaToken = outcome.mfaToken;
        return false;
      }
      _user = (outcome as auth.SignedIn).user;
      return true;
    } on auth.AuthError catch (e) {
      _error = e.message;
      return false;
    } catch (e) {
      _error = e.toString();
      return false;
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  Future<bool> completeMfa({String? code, String? backupCode}) async {
    if (_mfaToken == null) return false;
    _busy = true;
    _error = null;
    notifyListeners();
    try {
      _user = await auth.completeMfa(
        config: _config,
        mfaToken: _mfaToken!,
        code: code,
        backupCode: backupCode,
      );
      _mfaToken = null;
      return true;
    } on auth.AuthError catch (e) {
      _error = e.message;
      return false;
    } catch (e) {
      _error = e.toString();
      return false;
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  void cancelMfa() {
    _mfaToken = null;
    _error = null;
    notifyListeners();
  }

  Future<CaptureResult?> capture(CaptureMode mode) async {
    if (!isSignedIn) {
      _error = 'Sign in first.';
      notifyListeners();
      return null;
    }
    _busy = true;
    _error = null;
    notifyListeners();
    try {
      final result = await captureAndShare(_config, mode);
      if (result != null) recents.remember(result);
      return result;
    } catch (e) {
      _error = e.toString();
      return null;
    } finally {
      _busy = false;
      notifyListeners();
    }
  }
}
