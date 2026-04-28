import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:file_picker/file_picker.dart';
import 'package:stohr/stohr.dart';
import '../api/index.dart';
import '../widgets/items.dart';
import '../viewer/index.dart';
import '../upload/index.dart';
import '../settings/index.dart';

class BrowserScreen extends StatefulWidget {
  final int? folderId;
  final String? title;
  final String? folderKind;
  const BrowserScreen({super.key, this.folderId, this.title, this.folderKind});
  @override
  State<BrowserScreen> createState() => _BrowserScreenState();
}

class _BrowserScreenState extends State<BrowserScreen> {
  bool _loading = true;
  String? _error;
  List<Folder> _folders = const [];
  List<FileItem> _files = const [];

  bool get _isPhotos => widget.folderKind == 'photos';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final folders = await api.listFolders(parentId: widget.folderId);
      final files = await api.listFiles(folderId: widget.folderId);
      if (!mounted) return;
      setState(() {
        _folders = folders;
        _files = files;
        _loading = false;
      });
    } on StohrError catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    }
  }

  Future<void> _newFolder() async {
    final name = await _promptText(context, 'New folder', 'Folder name');
    if (name == null || name.trim().isEmpty) return;
    if (!mounted) return;
    String? kind;
    if (widget.folderId == null) {
      kind = await showDialog<String>(
        context: context,
        builder: (ctx) => SimpleDialog(
          title: const Text('Folder type'),
          children: [
            SimpleDialogOption(
              onPressed: () => Navigator.pop(ctx, 'standard'),
              child: const Text('Standard folder'),
            ),
            SimpleDialogOption(
              onPressed: () => Navigator.pop(ctx, 'photos'),
              child: const Text('Photos gallery'),
            ),
          ],
        ),
      );
      if (kind == null) return;
    }
    try {
      await api.createFolder(name.trim(), parentId: widget.folderId, kind: kind);
      await _load();
    } on StohrError catch (e) {
      if (mounted) _showSnack(e.message);
    }
  }

  Future<void> _uploadFromPicker() async {
    if (_isPhotos) {
      final picker = ImagePicker();
      final picked = await picker.pickMultiImage();
      if (picked.isEmpty) return;
      if (!mounted) return;
      await Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => UploadScreen(
          paths: picked.map((x) => x.path).toList(),
          folderId: widget.folderId,
        ),
      ));
    } else {
      final res = await FilePicker.platform.pickFiles(allowMultiple: true);
      if (res == null || res.files.isEmpty) return;
      final paths = res.files.where((f) => f.path != null).map((f) => f.path!).toList();
      if (paths.isEmpty) return;
      if (!mounted) return;
      await Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => UploadScreen(paths: paths, folderId: widget.folderId),
      ));
    }
    if (mounted) _load();
  }

  Future<void> _fileActions(FileItem f) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.drive_file_rename_outline),
              title: const Text('Rename'),
              onTap: () => Navigator.pop(ctx, 'rename'),
            ),
            ListTile(
              leading: const Icon(Icons.share_outlined),
              title: const Text('Share link'),
              onTap: () => Navigator.pop(ctx, 'share'),
            ),
            ListTile(
              leading: const Icon(Icons.delete_outline, color: Colors.redAccent),
              title: const Text('Delete', style: TextStyle(color: Colors.redAccent)),
              onTap: () => Navigator.pop(ctx, 'delete'),
            ),
          ],
        ),
      ),
    );
    if (!mounted) return;
    if (action == 'rename') {
      final name = await _promptText(context, 'Rename file', 'New name', initial: f.name);
      if (name == null || name.trim().isEmpty || name == f.name) return;
      try {
        await api.renameFile(f.id, name.trim());
        _load();
      } on StohrError catch (e) {
        if (mounted) _showSnack(e.message);
      }
    } else if (action == 'share') {
      try {
        final share = await api.createShare(f.id);
        final url = '${api.baseUrl.replaceAll('/api', '')}/s/${share.token}';
        if (!mounted) return;
        showDialog<void>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('Share link'),
            content: SelectableText(url),
            actions: [
              TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Done')),
            ],
          ),
        );
      } on StohrError catch (e) {
        if (mounted) _showSnack(e.message);
      }
    } else if (action == 'delete') {
      if (!mounted) return;
      final ok = await _confirm(context, 'Delete "${f.name}"?');
      if (ok != true) return;
      try {
        await api.deleteFile(f.id);
        _load();
      } on StohrError catch (e) {
        if (mounted) _showSnack(e.message);
      }
    }
  }

  void _showSnack(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title ?? 'Stohr'),
        actions: [
          if (widget.folderId == null)
            IconButton(
              icon: const Icon(Icons.settings_outlined),
              onPressed: () => Navigator.push(
                context,
                MaterialPageRoute(builder: (_) => const SettingsScreen()),
              ),
            ),
          IconButton(icon: const Icon(Icons.refresh), onPressed: _load),
        ],
      ),
      floatingActionButton: SpeedDialFab(
        onUpload: _uploadFromPicker,
        onNewFolder: _newFolder,
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(_error!, textAlign: TextAlign.center),
                        const SizedBox(height: 12),
                        FilledButton(onPressed: _load, child: const Text('Retry')),
                      ],
                    ),
                  ),
                )
              : RefreshIndicator(
                  onRefresh: _load,
                  child: _isPhotos ? _photoGrid() : _list(),
                ),
    );
  }

  Widget _list() {
    if (_folders.isEmpty && _files.isEmpty) return _empty();
    return ListView(
      children: [
        for (final f in _folders)
          FolderTile(
            folder: f,
            onTap: () => Navigator.push(
              context,
              MaterialPageRoute(
                builder: (_) => BrowserScreen(folderId: f.id, title: f.name, folderKind: f.kind),
              ),
            ).then((_) => _load()),
          ),
        if (_folders.isNotEmpty && _files.isNotEmpty) const Divider(height: 1),
        for (final f in _files)
          FileTile(
            file: f,
            onTap: () => Navigator.push(
              context,
              MaterialPageRoute(builder: (_) => ViewerScreen(file: f)),
            ),
            onLongPress: () => _fileActions(f),
          ),
      ],
    );
  }

  Widget _photoGrid() {
    final media = _files.where((f) => f.mime.startsWith('image/') || f.mime.startsWith('video/')).toList();
    if (_folders.isEmpty && media.isEmpty) return _empty();
    return CustomScrollView(
      slivers: [
        if (_folders.isNotEmpty)
          SliverList(
            delegate: SliverChildBuilderDelegate(
              (_, i) => FolderTile(
                folder: _folders[i],
                onTap: () => Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (_) => BrowserScreen(
                      folderId: _folders[i].id,
                      title: _folders[i].name,
                      folderKind: _folders[i].kind,
                    ),
                  ),
                ).then((_) => _load()),
              ),
              childCount: _folders.length,
            ),
          ),
        SliverPadding(
          padding: const EdgeInsets.all(8),
          sliver: SliverGrid(
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 3,
              crossAxisSpacing: 6,
              mainAxisSpacing: 6,
            ),
            delegate: SliverChildBuilderDelegate(
              (_, i) {
                final f = media[i];
                return PhotoThumb(
                  file: f,
                  onTap: () => Navigator.push(
                    context,
                    MaterialPageRoute(
                      builder: (_) => ViewerScreen(file: f, gallery: media, index: i),
                    ),
                  ),
                );
              },
              childCount: media.length,
            ),
          ),
        ),
      ],
    );
  }

  Widget _empty() {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        const SizedBox(height: 100),
        Icon(Icons.cloud_outlined, size: 56, color: Theme.of(context).hintColor),
        const SizedBox(height: 12),
        Center(
          child: Text(
            _isPhotos ? 'No photos yet' : 'Empty',
            style: Theme.of(context).textTheme.titleMedium,
          ),
        ),
        const SizedBox(height: 6),
        Center(
          child: Text(
            'Tap + to upload or create a folder',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ),
      ],
    );
  }
}

class SpeedDialFab extends StatefulWidget {
  final VoidCallback onUpload;
  final VoidCallback onNewFolder;
  const SpeedDialFab({super.key, required this.onUpload, required this.onNewFolder});
  @override
  State<SpeedDialFab> createState() => _SpeedDialFabState();
}

class _SpeedDialFabState extends State<SpeedDialFab> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        if (_open) ...[
          FloatingActionButton.small(
            heroTag: 'up',
            onPressed: () {
              setState(() => _open = false);
              widget.onUpload();
            },
            child: const Icon(Icons.upload_file),
          ),
          const SizedBox(height: 8),
          FloatingActionButton.small(
            heroTag: 'fld',
            onPressed: () {
              setState(() => _open = false);
              widget.onNewFolder();
            },
            child: const Icon(Icons.create_new_folder_outlined),
          ),
          const SizedBox(height: 8),
        ],
        FloatingActionButton(
          heroTag: 'main',
          onPressed: () => setState(() => _open = !_open),
          child: AnimatedRotation(
            turns: _open ? 0.125 : 0,
            duration: const Duration(milliseconds: 150),
            child: const Icon(Icons.add),
          ),
        ),
      ],
    );
  }
}

Future<String?> _promptText(BuildContext context, String title, String label, {String? initial}) {
  final ctrl = TextEditingController(text: initial ?? '');
  return showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: TextField(
        controller: ctrl,
        autofocus: true,
        decoration: InputDecoration(labelText: label),
        onSubmitted: (v) => Navigator.pop(ctx, v),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(ctx, ctrl.text), child: const Text('OK')),
      ],
    ),
  );
}

Future<bool?> _confirm(BuildContext context, String message) {
  return showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      content: Text(message),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
        FilledButton(
          style: FilledButton.styleFrom(backgroundColor: Colors.redAccent),
          onPressed: () => Navigator.pop(ctx, true),
          child: const Text('Delete'),
        ),
      ],
    ),
  );
}
