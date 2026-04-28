import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'types.dart';

class StohrError implements Exception {
  final int status;
  final String message;
  final Map<String, dynamic>? body;
  StohrError(this.message, this.status, this.body);
  @override
  String toString() => 'StohrError($status): $message';
}

class StohrClient {
  final String baseUrl;
  final http.Client _http;
  String? _token;

  StohrClient({String? baseUrl, http.Client? client, String? token})
      : baseUrl = (baseUrl ?? 'https://stohr.io/api').replaceAll(RegExp(r'/$'), ''),
        _http = client ?? http.Client(),
        _token = token;

  String? get token => _token;
  set token(String? t) => _token = t;

  Map<String, String> _headers([Map<String, String> extra = const {}]) {
    final h = <String, String>{...extra};
    if (_token != null) h['authorization'] = 'Bearer $_token';
    return h;
  }

  Future<dynamic> _json(String method, String path, {Object? body}) async {
    final uri = Uri.parse('$baseUrl$path');
    final headers = _headers(body != null ? const {'content-type': 'application/json'} : const {});
    final resp = await _http.send(
      http.Request(method, uri)
        ..headers.addAll(headers)
        ..body = body != null ? jsonEncode(body) : '',
    );
    final text = await resp.stream.bytesToString();
    final parsed = text.isEmpty ? null : jsonDecode(text);
    if (resp.statusCode < 200 || resp.statusCode >= 300 ||
        (parsed is Map<String, dynamic> && parsed.containsKey('error'))) {
      final msg = (parsed is Map<String, dynamic> && parsed['error'] != null)
          ? parsed['error'].toString()
          : 'HTTP ${resp.statusCode}';
      throw StohrError(msg, resp.statusCode, parsed is Map<String, dynamic> ? parsed : null);
    }
    return parsed;
  }

  // ── auth ──────────────────────────────────────────────

  Future<AuthResult> login(String identity, String password) async {
    final j = await _json('POST', '/login', body: {'identity': identity, 'password': password});
    final res = AuthResult.fromJson(j as Map<String, dynamic>);
    _token = res.token;
    return res;
  }

  Future<AuthResult> signup({
    required String name,
    required String username,
    required String email,
    required String password,
    String? inviteToken,
  }) async {
    final j = await _json('POST', '/signup', body: {
      'name': name,
      'username': username,
      'email': email,
      'password': password,
      if (inviteToken != null) 'invite_token': inviteToken,
    });
    final res = AuthResult.fromJson(j as Map<String, dynamic>);
    _token = res.token;
    return res;
  }

  // ── me ──────────────────────────────────────────────

  Future<User> me() async => User.fromJson(await _json('GET', '/me') as Map<String, dynamic>);
  Future<Subscription> subscription() async =>
      Subscription.fromJson(await _json('GET', '/me/subscription') as Map<String, dynamic>);

  // ── folders ─────────────────────────────────────────

  Future<List<Folder>> listFolders({int? parentId}) async {
    final r = await _json('GET', '/folders?parent_id=${parentId ?? 'null'}');
    return (r as List).map((j) => Folder.fromJson(j as Map<String, dynamic>)).toList();
  }

  Future<Folder> createFolder(String name, {int? parentId, String? kind, bool? isPublic}) async {
    final j = await _json('POST', '/folders', body: {
      'name': name,
      'parent_id': parentId,
      if (kind != null) 'kind': kind,
      if (isPublic != null) 'is_public': isPublic,
    });
    return Folder.fromJson(j as Map<String, dynamic>);
  }

  Future<void> deleteFolder(int id) async => _json('DELETE', '/folders/$id');

  Future<Folder> renameFolder(int id, String name) async =>
      Folder.fromJson(await _json('PATCH', '/folders/$id', body: {'name': name}) as Map<String, dynamic>);

  // ── files ──────────────────────────────────────────

  Future<List<FileItem>> listFiles({int? folderId, String? query}) async {
    final qs = query != null ? 'q=${Uri.encodeComponent(query)}' : 'folder_id=${folderId ?? 'null'}';
    final r = await _json('GET', '/files?$qs');
    return (r as List).map((j) => FileItem.fromJson(j as Map<String, dynamic>)).toList();
  }

  Future<FileItem> getFile(int id) async =>
      FileItem.fromJson(await _json('GET', '/files/$id') as Map<String, dynamic>);

  Future<List<FileItem>> uploadFile({
    required Uint8List bytes,
    required String name,
    String? mime,
    int? folderId,
  }) async {
    final uri = Uri.parse('$baseUrl/files');
    final req = http.MultipartRequest('POST', uri)
      ..headers.addAll(_headers())
      ..files.add(http.MultipartFile.fromBytes(name, bytes, filename: name));
    if (folderId != null) req.fields['folder_id'] = folderId.toString();
    final streamed = await _http.send(req);
    final text = await streamed.stream.bytesToString();
    final parsed = text.isEmpty ? null : jsonDecode(text);
    if (streamed.statusCode < 200 || streamed.statusCode >= 300 ||
        (parsed is Map<String, dynamic> && parsed.containsKey('error'))) {
      final msg = (parsed is Map<String, dynamic> && parsed['error'] != null)
          ? parsed['error'].toString()
          : 'HTTP ${streamed.statusCode}';
      throw StohrError(msg, streamed.statusCode, parsed is Map<String, dynamic> ? parsed : null);
    }
    return (parsed as List).map((j) => FileItem.fromJson(j as Map<String, dynamic>)).toList();
  }

  Future<Uint8List> downloadFile(int id) async {
    final resp = await _http.get(Uri.parse('$baseUrl/files/$id/download'), headers: _headers());
    if (resp.statusCode != 200) {
      throw StohrError('HTTP ${resp.statusCode}', resp.statusCode, null);
    }
    return resp.bodyBytes;
  }

  Future<void> deleteFile(int id) async => _json('DELETE', '/files/$id');

  Future<FileItem> renameFile(int id, String name) async =>
      FileItem.fromJson(await _json('PATCH', '/files/$id', body: {'name': name}) as Map<String, dynamic>);

  Future<FileItem> moveFile(int id, int? folderId) async =>
      FileItem.fromJson(await _json('PATCH', '/files/$id', body: {'folder_id': folderId}) as Map<String, dynamic>);

  // ── shares ─────────────────────────────────────────

  Future<Share> createShare(int fileId, {int? expiresInSeconds}) async {
    final j = await _json('POST', '/shares', body: {
      'file_id': fileId,
      if (expiresInSeconds != null) 'expires_in': expiresInSeconds,
    });
    return Share.fromJson(j as Map<String, dynamic>);
  }

  Future<void> deleteShare(int id) async => _json('DELETE', '/shares/$id');

  // ── collaborators ──────────────────────────────────

  Future<Map<String, dynamic>> addCollaborator(
    String kind,
    int id,
    String identity,
    String role,
  ) async =>
      await _json('POST', '/${kind}s/$id/collaborators',
          body: {'identity': identity, 'role': role}) as Map<String, dynamic>;

  Future<void> removeCollaborator(String kind, int id, int collabId) async =>
      _json('DELETE', '/${kind}s/$id/collaborators/$collabId');

  // ── s3 access keys ─────────────────────────────────

  Future<List<S3AccessKey>> listS3Keys() async {
    final r = await _json('GET', '/me/s3-keys');
    return (r as List).map((j) => S3AccessKey.fromJson(j as Map<String, dynamic>)).toList();
  }

  Future<S3AccessKey> createS3Key({String? name}) async {
    final j = await _json('POST', '/me/s3-keys', body: {if (name != null) 'name': name});
    return S3AccessKey.fromJson(j as Map<String, dynamic>);
  }

  Future<void> revokeS3Key(int id) async => _json('DELETE', '/me/s3-keys/$id');

  // ── apps ──────────────────────────────────────────

  Future<List<App>> listApps() async {
    final r = await _json('GET', '/me/apps');
    return (r as List).map((j) => App.fromJson(j as Map<String, dynamic>)).toList();
  }

  Future<App> createApp(String name, {String? description}) async {
    final j = await _json('POST', '/me/apps', body: {
      'name': name,
      if (description != null) 'description': description,
    });
    return App.fromJson(j as Map<String, dynamic>);
  }

  Future<void> revokeApp(int id) async => _json('DELETE', '/me/apps/$id');

  void close() => _http.close();
}
