import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'router.dart';
import 'state.dart';
import 'theme.dart';

class StohrApp extends ConsumerWidget {
  const StohrApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final apiAsync = ref.watch(apiProvider);
    final themeMode = ref.watch(themeModeProvider);

    // Attach Api to the session notifier once it's ready.
    ref.listen<AsyncValue<dynamic>>(apiProvider, (prev, next) {
      next.whenData((api) => ref.read(sessionProvider.notifier).attach(api));
    });

    final router = buildRouter(ref);

    return MaterialApp.router(
      title: 'Stohr',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(AppPalette.light, dark: false),
      darkTheme: buildTheme(AppPalette.dark, dark: true),
      themeMode: flutterThemeMode(themeMode),
      routerConfig: router,
      builder: (ctx, child) {
        if (apiAsync.isLoading) {
          return MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildTheme(AppPalette.light, dark: false),
            home: const Scaffold(body: Center(child: CircularProgressIndicator())),
          );
        }
        return child ?? const SizedBox.shrink();
      },
    );
  }
}
