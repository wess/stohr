import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../state.dart';
import 'files.dart';

class FolderScreen extends ConsumerStatefulWidget {
  final int folderId;
  const FolderScreen({super.key, required this.folderId});

  @override
  ConsumerState<FolderScreen> createState() => _FolderScreenState();
}

class _FolderScreenState extends ConsumerState<FolderScreen> {
  String? _title;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final api = ref.read(apiProvider).requireValue;
    try {
      final data = await api.getFolder(widget.folderId);
      if (!mounted) return;
      setState(() => _title = data['name']?.toString() ?? 'Folder');
    } catch (_) {
      if (!mounted) return;
      setState(() => _title = 'Folder');
    }
  }

  @override
  Widget build(BuildContext context) {
    return FilesScreen(
      folderId: widget.folderId,
      title: _title ?? 'Folder',
    );
  }
}
