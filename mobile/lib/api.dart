import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http_parser/http_parser.dart';
import 'package:path_provider/path_provider.dart';
import 'config.dart';
import 'models.dart';

class ApiException implements Exception {
  final String message;
  final int? status;
  ApiException(this.message, [this.status]);
  @override
  String toString() => message;
}

class Api {
  static const _tokenKey = 'stohr_token';
  static const _userKey = 'stohr_user';

  final Dio dio;
  final FlutterSecureStorage storage;
  String? _token;
  User? _user;

  Api._(this.dio, this.storage);

  static Future<Api> create() async {
    final storage = const FlutterSecureStorage();
    final dio = Dio(BaseOptions(
      baseUrl: AppConfig.apiUrl,
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(seconds: 30),
      validateStatus: (s) => s != null && s < 500,
    ));
    final api = Api._(dio, storage);
    await api._bootstrap();
    return api;
  }

  Future<void> _bootstrap() async {
    _token = await storage.read(key: _tokenKey);
    final u = await storage.read(key: _userKey);
    if (u != null) {
      try {
        _user = User.fromJson(jsonDecode(u) as Map<String, dynamic>);
      } catch (_) {}
    }
    dio.interceptors.add(InterceptorsWrapper(onRequest: (opts, handler) {
      if (_token != null) opts.headers['authorization'] = 'Bearer $_token';
      handler.next(opts);
    }));
  }

  String get baseUrl => AppConfig.apiUrl;
  String? get token => _token;
  User? get user => _user;

  Future<void> _setSession(String? token, User? user) async {
    _token = token;
    _user = user;
    if (token != null) {
      await storage.write(key: _tokenKey, value: token);
    } else {
      await storage.delete(key: _tokenKey);
    }
    if (user != null) {
      await storage.write(key: _userKey, value: jsonEncode(user.toJson()));
    } else {
      await storage.delete(key: _userKey);
    }
  }

  Map<String, dynamic> _asMap(Response r) {
    if (r.data is Map<String, dynamic>) return r.data as Map<String, dynamic>;
    throw ApiException('Unexpected response', r.statusCode);
  }

  List<T> _asList<T>(Response r, T Function(Map<String, dynamic>) map) {
    final data = r.data;
    if (data is List) {
      return data.map((e) => map(e as Map<String, dynamic>)).toList();
    }
    if (data is Map && data['error'] != null) {
      throw ApiException(data['error'].toString(), r.statusCode);
    }
    return <T>[];
  }

  void _ensureOk(Response r) {
    if (r.statusCode != null && r.statusCode! >= 400) {
      final msg = (r.data is Map && (r.data as Map)['error'] != null)
          ? (r.data as Map)['error'].toString()
          : 'HTTP ${r.statusCode}';
      throw ApiException(msg, r.statusCode);
    }
  }

  // ---------- auth ----------

  Future<User> signup(String name, String email, String password) async {
    final r = await dio.post('/signup', data: {
      'name': name,
      'email': email,
      'password': password,
    });
    _ensureOk(r);
    final m = _asMap(r);
    final u = User(id: m['id'] as int, email: m['email'] as String, name: m['name'] as String);
    await _setSession(m['token'] as String, u);
    return u;
  }

  Future<User> login(String email, String password) async {
    final r = await dio.post('/login', data: {'email': email, 'password': password});
    _ensureOk(r);
    final m = _asMap(r);
    final u = User(id: m['id'] as int, email: m['email'] as String, name: m['name'] as String);
    await _setSession(m['token'] as String, u);
    return u;
  }

  Future<void> signOut() => _setSession(null, null);

  // ---------- me ----------

  Future<User> getMe() async {
    final r = await dio.get('/me');
    _ensureOk(r);
    return User.fromJson(_asMap(r));
  }

  Future<User> updateProfile({String? name, String? email}) async {
    final r = await dio.patch('/me', data: {
      if (name != null) 'name': name,
      if (email != null) 'email': email,
    });
    _ensureOk(r);
    final m = _asMap(r);
    final u = User(id: m['id'] as int, email: m['email'] as String, name: m['name'] as String);
    await _setSession(m['token'] as String? ?? _token, u);
    return u;
  }

  Future<void> changePassword(String current, String next) async {
    final r = await dio.post('/me/password', data: {
      'current_password': current,
      'new_password': next,
    });
    _ensureOk(r);
  }

  Future<void> deleteAccount(String password) async {
    final r = await dio.delete('/me', data: {'password': password});
    _ensureOk(r);
    await _setSession(null, null);
  }

  // ---------- folders ----------

  Future<List<Folder>> listFolders(int? parentId) async {
    final r = await dio.get('/folders',
        queryParameters: {'parent_id': parentId?.toString() ?? 'null'});
    return _asList(r, Folder.fromJson);
  }

  Future<Map<String, dynamic>> getFolder(int id) async {
    final r = await dio.get('/folders/$id');
    _ensureOk(r);
    return _asMap(r);
  }

  Future<Folder> createFolder(String name, int? parentId) async {
    final r = await dio.post('/folders', data: {'name': name, 'parent_id': parentId});
    _ensureOk(r);
    return Folder.fromJson(_asMap(r));
  }

  Future<void> renameFolder(int id, String name) async {
    final r = await dio.patch('/folders/$id', data: {'name': name});
    _ensureOk(r);
  }

  Future<void> moveFolder(int id, int? parentId) async {
    final r = await dio.patch('/folders/$id', data: {'parent_id': parentId});
    _ensureOk(r);
  }

  Future<void> deleteFolder(int id) async {
    final r = await dio.delete('/folders/$id');
    _ensureOk(r);
  }

  Future<void> restoreFolder(int id) async {
    final r = await dio.post('/folders/$id/restore');
    _ensureOk(r);
  }

  Future<void> purgeFolder(int id) async {
    final r = await dio.delete('/folders/$id/purge');
    _ensureOk(r);
  }

  // ---------- files ----------

  Future<List<FileItem>> listFiles({int? folderId, String? query}) async {
    final params = <String, dynamic>{};
    if (query != null && query.isNotEmpty) {
      params['q'] = query;
    } else {
      params['folder_id'] = folderId?.toString() ?? 'null';
    }
    final r = await dio.get('/files', queryParameters: params);
    return _asList(r, FileItem.fromJson);
  }

  Future<FileItem> getFile(int id) async {
    final r = await dio.get('/files/$id');
    _ensureOk(r);
    return FileItem.fromJson(_asMap(r));
  }

  String downloadUrl(int id) => '$baseUrl/files/$id/download';

  Future<File> downloadToCache(int id, String name) async {
    final dir = await getTemporaryDirectory();
    final path =
        '${dir.path}/${DateTime.now().millisecondsSinceEpoch}_${_sanitize(name)}';
    await dio.download(
      downloadUrl(id),
      path,
      options: Options(headers: {if (_token != null) 'authorization': 'Bearer $_token'}),
    );
    return File(path);
  }

  Future<File> downloadVersionToCache(int fileId, int version, String name) async {
    final dir = await getTemporaryDirectory();
    final path =
        '${dir.path}/${DateTime.now().millisecondsSinceEpoch}_v${version}_${_sanitize(name)}';
    await dio.download(
      '$baseUrl/files/$fileId/versions/$version/download',
      path,
      options: Options(headers: {if (_token != null) 'authorization': 'Bearer $_token'}),
    );
    return File(path);
  }

  Future<List<FileItem>> uploadFiles({
    required List<File> files,
    int? folderId,
    void Function(int sent, int total)? onProgress,
  }) async {
    final form = FormData();
    for (final f in files) {
      final mime = _mimeFor(f.path);
      form.files.add(MapEntry(
        f.path.split('/').last,
        await MultipartFile.fromFile(
          f.path,
          filename: f.path.split('/').last,
          contentType: mime != null ? MediaType.parse(mime) : null,
        ),
      ));
    }
    if (folderId != null) form.fields.add(MapEntry('folder_id', folderId.toString()));
    final r = await dio.post(
      '/files',
      data: form,
      onSendProgress: onProgress,
    );
    _ensureOk(r);
    final data = r.data;
    if (data is List) return data.map((e) => FileItem.fromJson(e as Map<String, dynamic>)).toList();
    return [];
  }

  Future<void> renameFile(int id, String name) async {
    final r = await dio.patch('/files/$id', data: {'name': name});
    _ensureOk(r);
  }

  Future<void> moveFile(int id, int? folderId) async {
    final r = await dio.patch('/files/$id', data: {'folder_id': folderId});
    _ensureOk(r);
  }

  Future<void> deleteFile(int id) async {
    final r = await dio.delete('/files/$id');
    _ensureOk(r);
  }

  Future<void> restoreFile(int id) async {
    final r = await dio.post('/files/$id/restore');
    _ensureOk(r);
  }

  Future<void> purgeFile(int id) async {
    final r = await dio.delete('/files/$id/purge');
    _ensureOk(r);
  }

  // ---------- versions ----------

  Future<List<FileVersion>> listVersions(int fileId) async {
    final r = await dio.get('/files/$fileId/versions');
    return _asList(r, FileVersion.fromJson);
  }

  Future<void> restoreVersion(int fileId, int version) async {
    final r = await dio.post('/files/$fileId/versions/$version/restore');
    _ensureOk(r);
  }

  Future<void> deleteVersion(int fileId, int version) async {
    final r = await dio.delete('/files/$fileId/versions/$version');
    _ensureOk(r);
  }

  // ---------- shares ----------

  Future<List<ShareLink>> listShares() async {
    final r = await dio.get('/shares');
    return _asList(r, ShareLink.fromJson);
  }

  Future<String> createShare(int fileId, {int? expiresInSeconds}) async {
    final r = await dio.post('/shares', data: {
      'file_id': fileId,
      if (expiresInSeconds != null) 'expires_in': expiresInSeconds,
    });
    _ensureOk(r);
    return _asMap(r)['token'] as String;
  }

  Future<void> deleteShare(int id) async {
    final r = await dio.delete('/shares/$id');
    _ensureOk(r);
  }

  String publicShareUrl(String token) => '$baseUrl/s/$token';

  // ---------- trash ----------

  Future<({List<Folder> folders, List<FileItem> files})> listTrash() async {
    final r = await dio.get('/trash');
    _ensureOk(r);
    final m = _asMap(r);
    return (
      folders: (m['folders'] as List? ?? [])
          .map((e) => Folder.fromJson(e as Map<String, dynamic>))
          .toList(),
      files: (m['files'] as List? ?? [])
          .map((e) => FileItem.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  Future<void> emptyTrash() async {
    final r = await dio.delete('/trash');
    _ensureOk(r);
  }

  // ---------- helpers ----------

  static String _sanitize(String name) =>
      name.replaceAll(RegExp(r'[^a-zA-Z0-9._-]'), '_');

  static String? _mimeFor(String path) {
    final ext = path.toLowerCase().split('.').last;
    const map = {
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'heic': 'image/heic',
      'pdf': 'application/pdf',
      'mp3': 'audio/mpeg',
      'wav': 'audio/wav',
      'm4a': 'audio/mp4',
      'mp4': 'video/mp4',
      'mov': 'video/quicktime',
      'txt': 'text/plain',
      'json': 'application/json',
      'csv': 'text/csv',
      'zip': 'application/zip',
    };
    return map[ext];
  }
}
