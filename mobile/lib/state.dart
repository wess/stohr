import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'api.dart';
import 'models.dart';

final apiProvider = FutureProvider<Api>((ref) => Api.create());

final sessionProvider = StateNotifierProvider<SessionNotifier, User?>((ref) {
  final apiAsync = ref.watch(apiProvider);
  return SessionNotifier(apiAsync.valueOrNull);
});

class SessionNotifier extends StateNotifier<User?> {
  SessionNotifier(Api? api) : _api = api, super(api?.user);
  Api? _api;

  void attach(Api api) {
    _api = api;
    state = api.user;
  }

  Future<void> signIn(String email, String password) async {
    final u = await _api!.login(email, password);
    state = u;
  }

  Future<void> signUp(String name, String email, String password) async {
    final u = await _api!.signup(name, email, password);
    state = u;
  }

  Future<void> signOut() async {
    await _api!.signOut();
    state = null;
  }

  Future<void> refresh() async {
    state = _api?.user;
  }

  void updateUser(User u) => state = u;
}

enum ThemeMode2 { light, dark, system }

final themeModeProvider = StateNotifierProvider<ThemeModeNotifier, ThemeMode2>(
  (ref) => ThemeModeNotifier(),
);

class ThemeModeNotifier extends StateNotifier<ThemeMode2> {
  static const _key = 'stohr_theme';
  final _storage = const FlutterSecureStorage();

  ThemeModeNotifier() : super(ThemeMode2.system) {
    _load();
  }

  Future<void> _load() async {
    final v = await _storage.read(key: _key);
    if (v == 'light') state = ThemeMode2.light;
    else if (v == 'dark') state = ThemeMode2.dark;
    else state = ThemeMode2.system;
  }

  Future<void> set(ThemeMode2 mode) async {
    state = mode;
    if (mode == ThemeMode2.system) {
      await _storage.delete(key: _key);
    } else {
      await _storage.write(key: _key, value: mode.name);
    }
  }
}

ThemeMode flutterThemeMode(ThemeMode2 m) => switch (m) {
      ThemeMode2.light => ThemeMode.light,
      ThemeMode2.dark => ThemeMode.dark,
      ThemeMode2.system => ThemeMode.system,
    };
