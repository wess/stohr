import 'dart:typed_data';
import 'package:stohr/stohr.dart';
import '../auth/index.dart' as auth;
import '../config/index.dart';

Future<StohrClient> _client(StohrConfig config) async {
  final token = await auth.loadToken();
  if (token == null) throw auth.AuthError('Not signed in.');
  return StohrClient(baseUrl: config.serverUrl, token: token);
}

Future<User> currentUser(StohrConfig config) async {
  final c = await _client(config);
  try {
    return await c.me();
  } finally {
    c.close();
  }
}

Future<int> ensureScreenshotsFolder(StohrConfig config) async {
  final c = await _client(config);
  try {
    final folders = await c.listFolders();
    final existing = folders.where((f) => f.kind == 'screenshots').firstOrNull;
    if (existing != null) return existing.id;
    final created = await c.createFolder('Screenshots', kind: 'screenshots');
    return created.id;
  } finally {
    c.close();
  }
}

Future<FileItem> uploadScreenshot({
  required StohrConfig config,
  required Uint8List bytes,
  required String filename,
  required int folderId,
}) async {
  final c = await _client(config);
  try {
    final files = await c.uploadFile(
      bytes: bytes,
      name: filename,
      mime: 'image/png',
      folderId: folderId,
    );
    if (files.isEmpty) throw StateError('Upload returned no files');
    return files.first;
  } finally {
    c.close();
  }
}

Future<Share> createShareLink({
  required StohrConfig config,
  required int fileId,
  int expiresInSeconds = 30 * 86400,
}) async {
  final c = await _client(config);
  try {
    return await c.createShare(fileId, expiresInSeconds: expiresInSeconds);
  } finally {
    c.close();
  }
}

String shareUrl(StohrConfig config, String shareToken) {
  final base = config.serverUrl.replaceAll(RegExp(r'/api/?\$'), '');
  return '$base/s/$shareToken';
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull {
    final it = iterator;
    return it.moveNext() ? it.current : null;
  }
}
