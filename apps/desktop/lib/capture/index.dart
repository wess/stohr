import 'dart:io';
import 'dart:typed_data';
import 'package:path_provider/path_provider.dart';
import '../api/index.dart';
import '../config/index.dart';

enum CaptureMode { region, window, screen }

String _stamp(DateTime d) {
  String pad(int n) => n.toString().padLeft(2, '0');
  return '${d.year}-${pad(d.month)}-${pad(d.day)} at ${pad(d.hour)}.${pad(d.minute)}.${pad(d.second)}';
}

Future<({Uint8List bytes, String filename})?> grabScreenshot(CaptureMode mode) async {
  if (!Platform.isMacOS) {
    throw StateError('Screen capture is currently macOS-only.');
  }
  final tmp = await getTemporaryDirectory();
  final outPath = '${tmp.path}/stohrshot-${DateTime.now().millisecondsSinceEpoch}.png';
  final args = switch (mode) {
    CaptureMode.region => ['-i', '-x', outPath],
    CaptureMode.window => ['-iW', '-x', outPath],
    CaptureMode.screen => ['-x', outPath],
  };
  final result = await Process.run('/usr/sbin/screencapture', args);
  // screencapture returns 0 even on cancel — check the file.
  final f = File(outPath);
  if (!await f.exists() || await f.length() == 0) {
    if (await f.exists()) await f.delete().catchError((_) => f);
    return null;
  }
  if (result.exitCode != 0) {
    await f.delete().catchError((_) => f);
    return null;
  }
  final bytes = await f.readAsBytes();
  await f.delete().catchError((_) => f);
  return (bytes: bytes, filename: 'Screenshot ${_stamp(DateTime.now())}.png');
}

class CaptureResult {
  final String shareUrl;
  final int fileId;
  final String filename;
  final DateTime createdAt;
  CaptureResult({
    required this.shareUrl,
    required this.fileId,
    required this.filename,
    required this.createdAt,
  });
}

Future<CaptureResult?> captureAndShare(StohrConfig config, CaptureMode mode) async {
  final grabbed = await grabScreenshot(mode);
  if (grabbed == null) return null;
  final folderId = await ensureScreenshotsFolder(config);
  final file = await uploadScreenshot(
    config: config,
    bytes: grabbed.bytes,
    filename: grabbed.filename,
    folderId: folderId,
  );
  final share = await createShareLink(config: config, fileId: file.id);
  return CaptureResult(
    shareUrl: shareUrl(config, share.token),
    fileId: file.id,
    filename: grabbed.filename,
    createdAt: DateTime.now(),
  );
}

class RecentCaptures {
  static const _max = 10;
  final List<CaptureResult> _list = [];

  List<CaptureResult> get items => List.unmodifiable(_list);

  void remember(CaptureResult r) {
    _list.insert(0, r);
    if (_list.length > _max) _list.removeRange(_max, _list.length);
  }

  void clear() => _list.clear();
}

final recents = RecentCaptures();
