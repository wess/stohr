import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:share_plus/share_plus.dart';
import '../models.dart';
import '../state.dart';
import '../theme.dart';
import '../utils.dart';

class VersionsScreen extends ConsumerStatefulWidget {
  final int fileId;
  const VersionsScreen({super.key, required this.fileId});

  @override
  ConsumerState<VersionsScreen> createState() => _VersionsScreenState();
}

class _VersionsScreenState extends ConsumerState<VersionsScreen> {
  List<FileVersion> _versions = [];
  bool _loading = true;
  String? _name;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final api = ref.read(apiProvider).requireValue;
    try {
      final f = await api.getFile(widget.fileId);
      final list = await api.listVersions(widget.fileId);
      if (!mounted) return;
      setState(() { _versions = list; _name = f.name; _loading = false; });
    } catch (e) {
      if (!mounted) return;
      setState(() => _loading = false);
    }
  }

  Future<void> _download(FileVersion v) async {
    final api = ref.read(apiProvider).requireValue;
    try {
      final file = await api.downloadVersionToCache(widget.fileId, v.version, _name ?? 'file');
      await Share.shareXFiles([XFile(file.path, mimeType: v.mime)]);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<void> _restore(FileVersion v) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Restore v${v.version}?'),
        content: const Text('The current version will be saved as history.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Restore')),
        ],
      ),
    ) ?? false;
    if (!ok) return;
    final api = ref.read(apiProvider).requireValue;
    try { await api.restoreVersion(widget.fileId, v.version); await _load(); }
    catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<void> _remove(FileVersion v) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Delete v${v.version}?'),
        content: const Text('This cannot be undone.'),
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
    try { await api.deleteVersion(widget.fileId, v.version); await _load(); }
    catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Scaffold(
      backgroundColor: p.bg,
      appBar: AppBar(title: Text(_name == null ? 'Version history' : 'Versions of $_name', maxLines: 1, overflow: TextOverflow.ellipsis)),
      body: _loading
          ? Center(child: CircularProgressIndicator(color: p.brand))
          : ListView.builder(
              itemCount: _versions.length,
              itemBuilder: (ctx, i) {
                final v = _versions[i];
                return Container(
                  margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: v.isCurrent ? p.accentBg : p.panel,
                    border: Border.all(color: v.isCurrent ? p.brand : p.border),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(children: [
                              Text('v${v.version}', style: TextStyle(color: p.text, fontSize: 15, fontWeight: FontWeight.w600)),
                              if (v.isCurrent) ...[
                                const SizedBox(width: 8),
                                Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                                  decoration: BoxDecoration(color: p.brand, borderRadius: BorderRadius.circular(10)),
                                  child: Text('Current', style: TextStyle(color: p.brandFg, fontSize: 10, fontWeight: FontWeight.w700)),
                                ),
                              ],
                            ]),
                            const SizedBox(height: 4),
                            Text('${formatBytes(v.size)} · ${v.uploadedAt.toLocal().toString().split(".").first}',
                                style: TextStyle(color: p.muted, fontSize: 12)),
                          ],
                        ),
                      ),
                      IconButton(icon: Icon(LucideIcons.download, color: p.text, size: 18), onPressed: () => _download(v)),
                      if (!v.isCurrent) ...[
                        IconButton(icon: Icon(LucideIcons.rotateCcw, color: p.brand, size: 18), onPressed: () => _restore(v)),
                        IconButton(icon: Icon(LucideIcons.trash2, color: p.danger, size: 18), onPressed: () => _remove(v)),
                      ],
                    ],
                  ),
                );
              },
            ),
    );
  }
}
