class User {
  final int id;
  final String email;
  final String name;

  const User({required this.id, required this.email, required this.name});

  factory User.fromJson(Map<String, dynamic> j) => User(
        id: j['id'] as int,
        email: j['email'] as String,
        name: j['name'] as String,
      );

  Map<String, dynamic> toJson() => {'id': id, 'email': email, 'name': name};
}

class Folder {
  final int id;
  final String name;
  final int? parentId;
  final DateTime createdAt;
  final DateTime? deletedAt;

  const Folder({
    required this.id,
    required this.name,
    required this.parentId,
    required this.createdAt,
    this.deletedAt,
  });

  factory Folder.fromJson(Map<String, dynamic> j) => Folder(
        id: j['id'] as int,
        name: j['name'] as String,
        parentId: j['parent_id'] as int?,
        createdAt: DateTime.parse(j['created_at'] as String),
        deletedAt: j['deleted_at'] != null
            ? DateTime.parse(j['deleted_at'] as String)
            : null,
      );
}

class FileItem {
  final int id;
  final String name;
  final String mime;
  final int size;
  final int? folderId;
  final int version;
  final DateTime createdAt;
  final DateTime? deletedAt;

  const FileItem({
    required this.id,
    required this.name,
    required this.mime,
    required this.size,
    required this.folderId,
    required this.version,
    required this.createdAt,
    this.deletedAt,
  });

  factory FileItem.fromJson(Map<String, dynamic> j) => FileItem(
        id: j['id'] as int,
        name: j['name'] as String,
        mime: j['mime'] as String,
        size: (j['size'] as num).toInt(),
        folderId: j['folder_id'] as int?,
        version: (j['version'] as num?)?.toInt() ?? 1,
        createdAt: DateTime.parse(j['created_at'] as String),
        deletedAt: j['deleted_at'] != null
            ? DateTime.parse(j['deleted_at'] as String)
            : null,
      );
}

class Crumb {
  final int id;
  final String name;
  const Crumb({required this.id, required this.name});

  factory Crumb.fromJson(Map<String, dynamic> j) =>
      Crumb(id: j['id'] as int, name: j['name'] as String);
}

class ShareLink {
  final int id;
  final String token;
  final DateTime? expiresAt;
  final DateTime createdAt;
  final String name;
  final int size;
  final String mime;
  final int fileId;

  const ShareLink({
    required this.id,
    required this.token,
    required this.expiresAt,
    required this.createdAt,
    required this.name,
    required this.size,
    required this.mime,
    required this.fileId,
  });

  factory ShareLink.fromJson(Map<String, dynamic> j) => ShareLink(
        id: j['id'] as int,
        token: j['token'] as String,
        expiresAt: j['expires_at'] != null
            ? DateTime.parse(j['expires_at'] as String)
            : null,
        createdAt: DateTime.parse(j['created_at'] as String),
        name: j['name'] as String,
        size: (j['size'] as num).toInt(),
        mime: j['mime'] as String,
        fileId: j['file_id'] as int,
      );
}

class FileVersion {
  final int version;
  final String mime;
  final int size;
  final int? uploadedBy;
  final DateTime uploadedAt;
  final bool isCurrent;

  const FileVersion({
    required this.version,
    required this.mime,
    required this.size,
    required this.uploadedBy,
    required this.uploadedAt,
    required this.isCurrent,
  });

  factory FileVersion.fromJson(Map<String, dynamic> j) => FileVersion(
        version: (j['version'] as num).toInt(),
        mime: j['mime'] as String,
        size: (j['size'] as num).toInt(),
        uploadedBy: j['uploaded_by'] as int?,
        uploadedAt: DateTime.parse(j['uploaded_at'] as String),
        isCurrent: (j['is_current'] as bool?) ?? false,
      );
}
