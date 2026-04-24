import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons/lucide_icons.dart';
import '../models.dart';
import '../state.dart';
import '../theme.dart';
import '../utils.dart';
import '../widgets.dart';

class TrashScreen extends ConsumerStatefulWidget {
  const TrashScreen({super.key});

  @override
  ConsumerState<TrashScreen> createState() => _TrashScreenState();
}

class _TrashScreenState extends ConsumerState<TrashScreen> {
  List<Folder> _folders = [];
  List<FileItem> _files = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final api = ref.read(apiProvider).requireValue;
    try {
      final res = await api.listTrash();
      if (!mounted) return;
      setState(() { _folders = res.folders; _files = res.files; _loading = false; });
    } catch (e) {
      if (!mounted) return;
      setState(() => _loading = false);
    }
  }

  Future<void> _restore(String kind, int id) async {
    final api = ref.read(apiProvider).requireValue;
    try {
      if (kind == 'folder') await api.restoreFolder(id);
      else await api.restoreFile(id);
      await _load();
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<void> _purge(String kind, int id, String name) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete forever?'),
        content: Text(name),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            child: const Text('Delete'),
          ),
        ],
      ),
    ) ?? false;
    if (!ok) return;
    final api = ref.read(apiProvider).requireValue;
    try {
      if (kind == 'folder') await api.purgeFolder(id);
      else await api.purgeFile(id);
      await _load();
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<void> _empty() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Empty Trash?'),
        content: const Text('This will permanently delete all items in Trash.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            child: const Text('Empty'),
          ),
        ],
      ),
    ) ?? false;
    if (!ok) return;
    final api = ref.read(apiProvider).requireValue;
    try {
      await api.emptyTrash();
      await _load();
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final empty = _folders.isEmpty && _files.isEmpty;

    return Scaffold(
      backgroundColor: p.bg,
      appBar: AppBar(
        title: const Text('Trash'),
        actions: [
          if (!empty)
            TextButton(
              onPressed: _empty,
              child: Text('Empty', style: TextStyle(color: p.danger, fontWeight: FontWeight.w600)),
            ),
        ],
      ),
      body: _loading
          ? Center(child: CircularProgressIndicator(color: p.brand))
          : RefreshIndicator(
              onRefresh: _load,
              color: p.brand,
              child: empty
                  ? ListView(
                      physics: const AlwaysScrollableScrollPhysics(),
                      children: [
                        SizedBox(
                          height: MediaQuery.of(context).size.height * 0.6,
                          child: const EmptyState(
                            icon: LucideIcons.trash2,
                            title: 'Trash is empty',
                            subtitle: 'Deleted items appear here and stay recoverable',
                          ),
                        ),
                      ],
                    )
                  : ListView(
                      children: [
                        for (final f in _folders)
                          FolderRow(
                            folder: f,
                            trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                              IconButton(icon: Icon(LucideIcons.rotateCcw, color: p.brand, size: 18), onPressed: () => _restore('folder', f.id)),
                              IconButton(icon: Icon(LucideIcons.trash2, color: p.danger, size: 18), onPressed: () => _purge('folder', f.id, f.name)),
                            ]),
                          ),
                        for (final f in _files)
                          FileRow(
                            file: f,
                            metaOverride: '${formatBytes(f.size)} · Deleted ${f.deletedAt == null ? "" : relativeDate(f.deletedAt!)}',
                            trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                              IconButton(icon: Icon(LucideIcons.rotateCcw, color: p.brand, size: 18), onPressed: () => _restore('file', f.id)),
                              IconButton(icon: Icon(LucideIcons.trash2, color: p.danger, size: 18), onPressed: () => _purge('file', f.id, f.name)),
                            ]),
                          ),
                      ],
                    ),
            ),
    );
  }
}
