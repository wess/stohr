import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'screens/auth.dart';
import 'screens/folder.dart';
import 'screens/home.dart';
import 'screens/preview.dart';
import 'screens/versions.dart';
import 'state.dart';

GoRouter buildRouter(WidgetRef ref) {
  return GoRouter(
    initialLocation: '/',
    refreshListenable: _sessionListenable(ref),
    redirect: (context, state) {
      final apiAsync = ref.read(apiProvider);
      if (apiAsync.isLoading) return null;
      final user = ref.read(sessionProvider);
      final onAuth = state.matchedLocation == '/auth';
      if (user == null && !onAuth) return '/auth';
      if (user != null && onAuth) return '/';
      return null;
    },
    routes: [
      GoRoute(path: '/', builder: (_, __) => const HomeShell()),
      GoRoute(path: '/auth', builder: (_, __) => const AuthScreen()),
      GoRoute(
        path: '/folder/:id',
        builder: (_, s) => FolderScreen(folderId: int.parse(s.pathParameters['id']!)),
      ),
      GoRoute(
        path: '/file/:id',
        builder: (_, s) => FilePreviewScreen(fileId: int.parse(s.pathParameters['id']!)),
      ),
      GoRoute(
        path: '/versions/:id',
        builder: (_, s) => VersionsScreen(fileId: int.parse(s.pathParameters['id']!)),
      ),
    ],
  );
}

Listenable _sessionListenable(WidgetRef ref) {
  final notifier = ValueNotifier<int>(0);
  ref.listen(sessionProvider, (_, __) => notifier.value++);
  ref.listen(apiProvider, (_, __) => notifier.value++);
  return notifier;
}
