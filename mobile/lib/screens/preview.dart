import 'dart:io';
import 'package:chewie/chewie.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:just_audio/just_audio.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:pdfx/pdfx.dart';
import 'package:share_plus/share_plus.dart';
import 'package:video_player/video_player.dart';
import '../models.dart';
import '../state.dart';
import '../theme.dart';
import '../utils.dart';

class FilePreviewScreen extends ConsumerStatefulWidget {
  final int fileId;
  const FilePreviewScreen({super.key, required this.fileId});

  @override
  ConsumerState<FilePreviewScreen> createState() => _FilePreviewScreenState();
}

class _FilePreviewScreenState extends ConsumerState<FilePreviewScreen> {
  FileItem? _file;
  File? _local;
  String? _text;
  String? _error;

  VideoPlayerController? _video;
  ChewieController? _chewie;
  AudioPlayer? _audio;
  PdfController? _pdf;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _start());
  }

  Future<void> _start() async {
    final api = ref.read(apiProvider).requireValue;
    try {
      final f = await api.getFile(widget.fileId);
      if (!mounted) return;
      setState(() => _file = f);
      final kind = previewKindFor(f.mime);
      if (kind == PreviewKind.text) {
        final local = await api.downloadToCache(widget.fileId, f.name);
        final text = await local.readAsString();
        if (!mounted) return;
        setState(() { _local = local; _text = text; });
      } else if (kind == PreviewKind.other) {
        // metadata only
      } else {
        final local = await api.downloadToCache(widget.fileId, f.name);
        if (!mounted) return;
        setState(() => _local = local);
        await _prepareMedia(kind, local, f.mime);
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = '$e');
    }
  }

  Future<void> _prepareMedia(PreviewKind kind, File local, String mime) async {
    switch (kind) {
      case PreviewKind.video:
        final v = VideoPlayerController.file(local);
        await v.initialize();
        final c = ChewieController(
          videoPlayerController: v,
          autoPlay: true,
          looping: false,
          allowFullScreen: true,
          showControlsOnInitialize: true,
        );
        if (!mounted) return;
        setState(() { _video = v; _chewie = c; });
        break;
      case PreviewKind.audio:
        final a = AudioPlayer();
        await a.setFilePath(local.path);
        a.play();
        if (!mounted) return;
        setState(() => _audio = a);
        break;
      case PreviewKind.pdf:
        final doc = await PdfDocument.openFile(local.path);
        if (!mounted) return;
        setState(() => _pdf = PdfController(document: Future.value(doc)));
        break;
      default:
        break;
    }
  }

  @override
  void dispose() {
    _chewie?.dispose();
    _video?.dispose();
    _audio?.dispose();
    _pdf?.dispose();
    super.dispose();
  }

  Future<void> _share() async {
    if (_local == null || _file == null) return;
    await Share.shareXFiles([XFile(_local!.path, mimeType: _file!.mime, name: _file!.name)]);
  }

  Future<void> _createLink() async {
    if (_file == null) return;
    final api = ref.read(apiProvider).requireValue;
    try {
      final token = await api.createShare(_file!.id);
      final url = api.publicShareUrl(token);
      await Clipboard.setData(ClipboardData(text: url));
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Link copied: $url')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<void> _delete() async {
    if (_file == null) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Move to Trash?'),
        content: Text(_file!.name),
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
    await api.deleteFile(_file!.id);
    if (!mounted) return;
    context.pop();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final f = _file;

    return Scaffold(
      backgroundColor: p.bg,
      appBar: AppBar(title: Text(f?.name ?? 'Preview', maxLines: 1, overflow: TextOverflow.ellipsis)),
      bottomNavigationBar: f == null ? null : BottomAppBar(
        color: p.panel,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceAround,
          children: [
            _actionBtn(LucideIcons.download, 'Save', _share),
            _actionBtn(LucideIcons.share2, 'Share', _share),
            _actionBtn(LucideIcons.link2, 'Link', _createLink),
            if (f.version > 1) _actionBtn(LucideIcons.history, 'Versions', () => context.push('/versions/${f.id}')),
            _actionBtn(LucideIcons.trash2, 'Delete', _delete, danger: true),
          ],
        ),
      ),
      body: _error != null
          ? Center(child: Text(_error!, style: TextStyle(color: p.danger)))
          : f == null
              ? Center(child: CircularProgressIndicator(color: p.brand))
              : _body(f),
    );
  }

  Widget _actionBtn(IconData icon, String label, VoidCallback onTap, {bool danger = false}) {
    final p = context.p;
    final color = danger ? p.danger : p.text;
    return Expanded(
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, color: color, size: 20),
              const SizedBox(height: 4),
              Text(label, style: TextStyle(color: color, fontSize: 11)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _body(FileItem f) {
    final p = context.p;
    final kind = previewKindFor(f.mime);

    if (kind == PreviewKind.other) return _otherFallback(f);
    if (_local == null && kind != PreviewKind.text) {
      return Center(child: CircularProgressIndicator(color: p.brand));
    }

    switch (kind) {
      case PreviewKind.image:
        return InteractiveViewer(
          child: Center(child: Image.file(_local!, fit: BoxFit.contain)),
        );
      case PreviewKind.video:
        return _chewie == null
            ? Center(child: CircularProgressIndicator(color: p.brand))
            : Chewie(controller: _chewie!);
      case PreviewKind.audio:
        return _audioPreview(f);
      case PreviewKind.pdf:
        return _pdf == null
            ? Center(child: CircularProgressIndicator(color: p.brand))
            : PdfView(controller: _pdf!, scrollDirection: Axis.vertical);
      case PreviewKind.text:
        return SingleChildScrollView(
          padding: const EdgeInsets.all(14),
          child: SelectableText(
            _text ?? '',
            style: TextStyle(color: p.text, fontFamily: 'Menlo', fontSize: 12, height: 1.5),
          ),
        );
      case PreviewKind.other:
        return _otherFallback(f);
    }
  }

  Widget _otherFallback(FileItem f) {
    final p = context.p;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(iconForMime(f.mime), color: p.muted, size: 96),
            const SizedBox(height: 14),
            Text(f.name, style: TextStyle(color: p.text, fontSize: 16, fontWeight: FontWeight.w600), textAlign: TextAlign.center),
            const SizedBox(height: 4),
            Text('${formatBytes(f.size)} · ${f.mime}', style: TextStyle(color: p.muted, fontSize: 13)),
            const SizedBox(height: 20),
            ElevatedButton(onPressed: _share, child: const Text('Open / Share')),
          ],
        ),
      ),
    );
  }

  Widget _audioPreview(FileItem f) {
    final p = context.p;
    final player = _audio;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(LucideIcons.music, color: p.brand, size: 96),
            const SizedBox(height: 16),
            Text(f.name, style: TextStyle(color: p.text, fontSize: 16, fontWeight: FontWeight.w600), maxLines: 1, overflow: TextOverflow.ellipsis),
            const SizedBox(height: 16),
            if (player != null) StreamBuilder<PlayerState>(
              stream: player.playerStateStream,
              builder: (ctx, snap) {
                final playing = snap.data?.playing ?? false;
                return Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    IconButton(
                      iconSize: 56,
                      icon: Icon(playing ? Icons.pause_circle_filled : Icons.play_circle_filled, color: p.brand),
                      onPressed: () => playing ? player.pause() : player.play(),
                    ),
                  ],
                );
              },
            ),
            StreamBuilder<Duration>(
              stream: player?.positionStream ?? const Stream.empty(),
              builder: (ctx, snap) {
                final pos = snap.data ?? Duration.zero;
                final dur = player?.duration ?? Duration.zero;
                return Column(
                  children: [
                    Slider(
                      value: pos.inMilliseconds.clamp(0, dur.inMilliseconds == 0 ? 1 : dur.inMilliseconds).toDouble(),
                      max: (dur.inMilliseconds == 0 ? 1 : dur.inMilliseconds).toDouble(),
                      onChanged: dur.inMilliseconds == 0 ? null : (v) => player?.seek(Duration(milliseconds: v.round())),
                      activeColor: p.brand,
                    ),
                    Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                      Text(_fmt(pos), style: TextStyle(color: p.muted, fontSize: 12)),
                      Text(_fmt(dur), style: TextStyle(color: p.muted, fontSize: 12)),
                    ]),
                  ],
                );
              },
            ),
          ],
        ),
      ),
    );
  }

  String _fmt(Duration d) {
    final m = d.inMinutes.remainder(60).toString().padLeft(2, '0');
    final s = d.inSeconds.remainder(60).toString().padLeft(2, '0');
    return d.inHours > 0 ? '${d.inHours}:$m:$s' : '$m:$s';
  }
}
