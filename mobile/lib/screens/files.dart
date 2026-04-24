import 'dart:async';
import 'dart:io';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:share_plus/share_plus.dart';
import 'package:flutter/services.dart';
import '../api.dart';
import '../models.dart';
import '../state.dart';
import '../theme.dart';
import '../utils.dart';
import '../widgets.dart';

class FilesScreen extends ConsumerStatefulWidget {
  final int? folderId;
  final String? title;
  final bool showAppBar;

  const FilesScreen({super.key, this.folderId, this.title, this.showAppBar = true});

  @override
  ConsumerState<FilesScreen> createState() => _FilesScreenState();
}

class _FilesScreenState extends ConsumerState<FilesScreen> {
  List<Folder> _folders = [];
  List<FileItem> _files = [];
  bool _loading = true;
  String _search = '';
  bool _showSearch = false;
  final _searchCtl = TextEditingController();
  Timer? _debounce;

  ({int sent, int total, String name})? _progress;

  Api get api => ref.read(apiProvider).requireValue;

  @override
  void dispose() {
    _searchCtl.dispose();
    _debounce?.cancel();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    if (!mounted) return;
    try {
      final fos = widget.folderId == null || _search.isNotEmpty
          ? <Folder>[]
          : await api.listFolders(widget.folderId);
      final fis = await api.listFiles(
        folderId: widget.folderId,
        query: _search.isEmpty ? null : _search,
      );
      final rootFos = widget.folderId == null && _search.isEmpty
          ? await api.listFolders(null)
          : fos;
      if (!mounted) return;
      setState(() {
        _folders = _search.isEmpty ? rootFos : [];
        _files = fis;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _loading = false);
      _snack('Load failed: $e');
    }
  }

  void _snack(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _uploadFiles(List<File> files) async {
    try {
      for (final file in files) {
        if (!mounted) return;
        setState(() => _progress = (sent: 0, total: 1, name: file.path.split('/').last));
        await api.uploadFiles(
          files: [file],
          folderId: widget.folderId,
          onProgress: (sent, total) {
            if (!mounted) return;
            setState(() => _progress = (sent: sent, total: total, name: file.path.split('/').last));
          },
        );
      }
      if (!mounted) return;
      setState(() => _progress = null);
      await _load();
    } catch (e) {
      if (!mounted) return;
      setState(() => _progress = null);
      _snack('Upload failed: $e');
    }
  }

  Future<void> _pickDocument() async {
    final res = await FilePicker.platform.pickFiles(allowMultiple: true);
    if (res == null || res.files.isEmpty) return;
    final files = res.paths.whereType<String>().map((p) => File(p)).toList();
    await _uploadFiles(files);
  }

  Future<void> _pickPhoto() async {
    final picker = ImagePicker();
    final list = await picker.pickMultipleMedia();
    if (list.isEmpty) return;
    await _uploadFiles(list.map((x) => File(x.path)).toList());
  }

  Future<void> _pickCamera() async {
    final picker = ImagePicker();
    final x = await picker.pickImage(source: ImageSource.camera);
    if (x == null) return;
    await _uploadFiles([File(x.path)]);
  }

  Future<void> _newFolder() async {
    final name = await _prompt('New folder', label: 'Folder name');
    if (name == null || name.trim().isEmpty) return;
    try {
      await api.createFolder(name.trim(), widget.folderId);
      await _load();
    } catch (e) {
      _snack('$e');
    }
  }

  Future<String?> _prompt(String title, {required String label, String initial = '', bool obscure = false}) async {
    final ctl = TextEditingController(text: initial);
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: TextField(
          controller: ctl,
          autofocus: true,
          obscureText: obscure,
          decoration: InputDecoration(labelText: label),
          onSubmitted: (v) => Navigator.pop(ctx, v),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          ElevatedButton(onPressed: () => Navigator.pop(ctx, ctl.text), child: const Text('OK')),
        ],
      ),
    );
  }

  void _showAddSheet() {
    final p = context.p;
    showModalBottomSheet(
      context: context,
      backgroundColor: p.panel,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            _sheetItem(ctx, LucideIcons.upload, 'Upload file', () { Navigator.pop(ctx); _pickDocument(); }),
            _sheetItem(ctx, LucideIcons.image, 'Photo or video', () { Navigator.pop(ctx); _pickPhoto(); }),
            _sheetItem(ctx, LucideIcons.camera, 'Take photo', () { Navigator.pop(ctx); _pickCamera(); }),
            _sheetItem(ctx, LucideIcons.folderPlus, 'New folder', () { Navigator.pop(ctx); _newFolder(); }),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  Widget _sheetItem(BuildContext ctx, IconData icon, String label, VoidCallback onTap) {
    final p = ctx.p;
    return ListTile(
      leading: Icon(icon, color: p.brand),
      title: Text(label, style: TextStyle(color: p.text)),
      onTap: onTap,
    );
  }

  Future<void> _showFolderActions(Folder f) async {
    final p = context.p;
    final action = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: p.panel,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(f.name, style: TextStyle(color: p.text, fontWeight: FontWeight.w600)),
            ),
            _sheetItem(ctx, LucideIcons.pencil, 'Rename', () => Navigator.pop(ctx, 'rename')),
            _sheetItem(ctx, LucideIcons.trash2, 'Delete', () => Navigator.pop(ctx, 'delete')),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (action == 'rename') {
      final name = await _prompt('Rename folder', label: 'Name', initial: f.name);
      if (name == null || name.trim().isEmpty) return;
      try { await api.renameFolder(f.id, name.trim()); await _load(); } catch (e) { _snack('$e'); }
    } else if (action == 'delete') {
      if (await _confirm('Move to Trash?', f.name, destructive: true)) {
        try { await api.deleteFolder(f.id); await _load(); } catch (e) { _snack('$e'); }
      }
    }
  }

  Future<void> _showFileActions(FileItem f) async {
    final p = context.p;
    final action = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: p.panel,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(f.name, style: TextStyle(color: p.text, fontWeight: FontWeight.w600)),
            ),
            _sheetItem(ctx, LucideIcons.share2, 'Save / Share', () => Navigator.pop(ctx, 'share')),
            _sheetItem(ctx, LucideIcons.link2, 'Create link', () => Navigator.pop(ctx, 'link')),
            if (f.version > 1)
              _sheetItem(ctx, LucideIcons.history, 'Version history', () => Navigator.pop(ctx, 'versions')),
            _sheetItem(ctx, LucideIcons.pencil, 'Rename', () => Navigator.pop(ctx, 'rename')),
            _sheetItem(ctx, LucideIcons.trash2, 'Delete', () => Navigator.pop(ctx, 'delete')),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (action == 'share') {
      try {
        final file = await api.downloadToCache(f.id, f.name);
        await Share.shareXFiles([XFile(file.path, mimeType: f.mime, name: f.name)]);
      } catch (e) { _snack('$e'); }
    } else if (action == 'link') {
      try {
        final token = await api.createShare(f.id);
        final url = api.publicShareUrl(token);
        await Clipboard.setData(ClipboardData(text: url));
        _snack('Link copied: $url');
      } catch (e) { _snack('$e'); }
    } else if (action == 'versions') {
      if (!mounted) return;
      context.push('/versions/${f.id}');
    } else if (action == 'rename') {
      final name = await _prompt('Rename file', label: 'Name', initial: f.name);
      if (name == null || name.trim().isEmpty) return;
      try { await api.renameFile(f.id, name.trim()); await _load(); } catch (e) { _snack('$e'); }
    } else if (action == 'delete') {
      if (await _confirm('Move to Trash?', f.name, destructive: true)) {
        try { await api.deleteFile(f.id); await _load(); } catch (e) { _snack('$e'); }
      }
    }
  }

  Future<bool> _confirm(String title, String msg, {bool destructive = false}) async {
    return await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Text(msg),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: destructive ? Colors.red : null),
            child: Text(destructive ? 'Delete' : 'OK'),
          ),
        ],
      ),
    ) ?? false;
  }

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final items = [
      ..._folders.map((f) => (kind: 'folder', folder: f, file: null as FileItem?)),
      ..._files.map((f) => (kind: 'file', folder: null as Folder?, file: f)),
    ];

    final body = Column(
      children: [
        if (_showSearch)
          Container(
            color: p.panel,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: Row(
              children: [
                Icon(LucideIcons.search, color: p.muted, size: 18),
                const SizedBox(width: 10),
                Expanded(
                  child: TextField(
                    controller: _searchCtl,
                    autofocus: true,
                    decoration: InputDecoration(
                      hintText: 'Search files...',
                      border: InputBorder.none,
                      enabledBorder: InputBorder.none,
                      focusedBorder: InputBorder.none,
                      filled: false,
                      isDense: true,
                    ),
                    onChanged: (v) {
                      _debounce?.cancel();
                      _debounce = Timer(const Duration(milliseconds: 300), () {
                        setState(() => _search = v);
                        _load();
                      });
                    },
                  ),
                ),
                IconButton(
                  icon: Icon(LucideIcons.x, color: p.muted, size: 18),
                  onPressed: () {
                    setState(() { _showSearch = false; _search = ''; _searchCtl.clear(); });
                    _load();
                  },
                ),
              ],
            ),
          ),
        if (_progress != null)
          Container(
            color: p.panel,
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Uploading ${_progress!.name}... ${((_progress!.sent / (_progress!.total == 0 ? 1 : _progress!.total)) * 100).round()}%',
                  style: TextStyle(color: p.text, fontSize: 13),
                  maxLines: 1, overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 6),
                LinearProgressIndicator(
                  value: _progress!.total == 0 ? null : _progress!.sent / _progress!.total,
                  backgroundColor: p.hover,
                  valueColor: AlwaysStoppedAnimation(p.brand),
                  minHeight: 4,
                ),
              ],
            ),
          ),
        Expanded(
          child: _loading
              ? Center(child: CircularProgressIndicator(color: p.brand))
              : RefreshIndicator(
                  onRefresh: _load,
                  color: p.brand,
                  child: items.isEmpty
                      ? ListView(
                          physics: const AlwaysScrollableScrollPhysics(),
                          children: [
                            SizedBox(
                              height: MediaQuery.of(context).size.height * 0.55,
                              child: _search.isNotEmpty
                                  ? EmptyState(icon: LucideIcons.search, title: 'No files match "$_search"')
                                  : EmptyState(
                                      icon: LucideIcons.inbox,
                                      title: 'This folder is empty',
                                      subtitle: 'Tap + to upload files or create a folder',
                                    ),
                            ),
                          ],
                        )
                      : ListView.builder(
                          itemCount: items.length,
                          itemBuilder: (ctx, i) {
                            final it = items[i];
                            if (it.kind == 'folder') {
                              return FolderRow(
                                folder: it.folder!,
                                onTap: () => context.push('/folder/${it.folder!.id}'),
                                onLongPress: () => _showFolderActions(it.folder!),
                              );
                            }
                            return FileRow(
                              file: it.file!,
                              onTap: () => context.push('/file/${it.file!.id}'),
                              onLongPress: () => _showFileActions(it.file!),
                            );
                          },
                        ),
                ),
        ),
      ],
    );

    final appBar = widget.showAppBar
        ? AppBar(
            title: Text(widget.title ?? 'Files'),
            actions: [
              IconButton(icon: Icon(LucideIcons.search, color: p.text), onPressed: () => setState(() => _showSearch = true)),
            ],
          )
        : null;

    return Scaffold(
      backgroundColor: p.bg,
      appBar: appBar,
      body: body,
      floatingActionButton: FloatingActionButton(
        backgroundColor: p.brand,
        foregroundColor: p.brandFg,
        onPressed: _showAddSheet,
        child: const Icon(LucideIcons.plus),
      ),
    );
  }
}
