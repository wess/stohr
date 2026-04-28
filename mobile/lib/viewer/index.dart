import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:share_plus/share_plus.dart' as sp;
import 'package:stohr/stohr.dart';
import '../api/index.dart';
import '../share/index.dart';

class ViewerScreen extends StatefulWidget {
  final FileItem file;
  final List<FileItem>? gallery;
  final int? index;
  const ViewerScreen({super.key, required this.file, this.gallery, this.index});
  @override
  State<ViewerScreen> createState() => _ViewerScreenState();
}

class _ViewerScreenState extends State<ViewerScreen> {
  late final PageController _page = PageController(initialPage: widget.index ?? 0);
  late int _current = widget.index ?? 0;

  List<FileItem> get _items => widget.gallery ?? [widget.file];

  Map<String, String> get _authHeader =>
      api.token != null ? {'authorization': 'Bearer ${api.token}'} : const {};

  String _url(FileItem f) => '${api.baseUrl}/files/${f.id}/download';

  Future<void> _share() async {
    final f = _items[_current];
    final s = await showCreateShareSheet(context, f);
    if (s == null) return;
    final url = '${api.baseUrl.replaceAll('/api', '')}/s/${s.token}';
    await sp.Share.share(url, subject: f.name);
  }

  Widget _content(FileItem f) {
    final mime = f.mime;
    if (mime.startsWith('image/')) {
      return InteractiveViewer(
        child: CachedNetworkImage(
          imageUrl: _url(f),
          httpHeaders: _authHeader,
          fit: BoxFit.contain,
          placeholder: (_, _) => const Center(child: CircularProgressIndicator()),
          errorWidget: (_, _, _) => const Center(
            child: Icon(Icons.broken_image_outlined, size: 48, color: Colors.white),
          ),
        ),
      );
    }
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(_iconFor(mime), size: 56, color: Colors.white70),
            const SizedBox(height: 12),
            Text(f.name,
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            Text(mime, style: const TextStyle(color: Colors.white54, fontSize: 12)),
            const SizedBox(height: 20),
            FilledButton.icon(
              icon: const Icon(Icons.share_outlined),
              label: const Text('Share link'),
              onPressed: _share,
            ),
          ],
        ),
      ),
    );
  }

  IconData _iconFor(String mime) {
    if (mime.startsWith('video/')) return Icons.movie_outlined;
    if (mime.startsWith('audio/')) return Icons.music_note_outlined;
    if (mime.contains('pdf')) return Icons.picture_as_pdf_outlined;
    if (mime.contains('zip')) return Icons.archive_outlined;
    return Icons.insert_drive_file_outlined;
  }

  @override
  Widget build(BuildContext context) {
    final current = _items[_current];
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: Text(current.name, overflow: TextOverflow.ellipsis),
        actions: [
          IconButton(icon: const Icon(Icons.share_outlined), onPressed: _share),
        ],
      ),
      body: PageView.builder(
        controller: _page,
        itemCount: _items.length,
        onPageChanged: (i) => setState(() => _current = i),
        itemBuilder: (_, i) => _content(_items[i]),
      ),
    );
  }
}
