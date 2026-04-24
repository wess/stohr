import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';
import '../theme.dart';
import 'files.dart';
import 'settings.dart';
import 'shares.dart';
import 'trash.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _idx = 0;

  final _screens = const [
    FilesScreen(),
    SharesScreen(),
    TrashScreen(),
    SettingsScreen(),
  ];

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Scaffold(
      body: IndexedStack(index: _idx, children: _screens),
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: _idx,
        onTap: (i) => setState(() => _idx = i),
        backgroundColor: p.panel,
        items: [
          BottomNavigationBarItem(icon: const Icon(LucideIcons.folderOpen), label: 'Files'),
          BottomNavigationBarItem(icon: const Icon(LucideIcons.link2), label: 'Shared'),
          BottomNavigationBarItem(icon: const Icon(LucideIcons.trash2), label: 'Trash'),
          BottomNavigationBarItem(icon: const Icon(LucideIcons.settings), label: 'Settings'),
        ],
      ),
    );
  }
}
