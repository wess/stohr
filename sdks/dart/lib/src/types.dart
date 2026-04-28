class User {
  final int id;
  final String email;
  final String username;
  final String name;
  final bool isOwner;
  final String? createdAt;

  User({
    required this.id,
    required this.email,
    required this.username,
    required this.name,
    required this.isOwner,
    this.createdAt,
  });

  factory User.fromJson(Map<String, dynamic> j) => User(
        id: j['id'] as int,
        email: j['email'] as String,
        username: j['username'] as String,
        name: j['name'] as String,
        isOwner: (j['is_owner'] as bool?) ?? false,
        createdAt: j['created_at'] as String?,
      );
}

class AuthResult {
  final User user;
  final String token;
  AuthResult({required this.user, required this.token});

  factory AuthResult.fromJson(Map<String, dynamic> j) =>
      AuthResult(user: User.fromJson(j), token: j['token'] as String);
}

class MfaChallenge {
  final String mfaToken;
  MfaChallenge(this.mfaToken);
}

class Folder {
  final int id;
  final String name;
  final int? parentId;
  final String? kind;
  final bool? isPublic;
  final String createdAt;

  Folder({
    required this.id,
    required this.name,
    required this.parentId,
    required this.kind,
    required this.isPublic,
    required this.createdAt,
  });

  factory Folder.fromJson(Map<String, dynamic> j) => Folder(
        id: j['id'] as int,
        name: j['name'] as String,
        parentId: j['parent_id'] as int?,
        kind: j['kind'] as String?,
        isPublic: j['is_public'] as bool?,
        createdAt: j['created_at'] as String,
      );
}

class FileItem {
  final int id;
  final String name;
  final String mime;
  final int size;
  final int? folderId;
  final int version;
  final String createdAt;

  FileItem({
    required this.id,
    required this.name,
    required this.mime,
    required this.size,
    required this.folderId,
    required this.version,
    required this.createdAt,
  });

  factory FileItem.fromJson(Map<String, dynamic> j) => FileItem(
        id: j['id'] as int,
        name: j['name'] as String,
        mime: j['mime'] as String,
        size: (j['size'] as num).toInt(),
        folderId: j['folder_id'] as int?,
        version: (j['version'] as num).toInt(),
        createdAt: j['created_at'] as String,
      );
}

class Share {
  final int id;
  final String token;
  final String? expiresAt;
  final String? createdAt;
  final int? fileId;
  final bool burnOnView;
  final bool passwordRequired;

  Share({
    required this.id,
    required this.token,
    required this.expiresAt,
    required this.createdAt,
    required this.fileId,
    required this.burnOnView,
    required this.passwordRequired,
  });

  factory Share.fromJson(Map<String, dynamic> j) => Share(
        id: j['id'] as int,
        token: j['token'] as String,
        expiresAt: j['expires_at'] as String?,
        createdAt: j['created_at'] as String?,
        fileId: j['file_id'] as int?,
        burnOnView: (j['burn_on_view'] as bool?) ?? false,
        passwordRequired: (j['password_required'] as bool?) ?? false,
      );
}

class Subscription {
  final String tier;
  final int quotaBytes;
  final int usedBytes;
  final String? status;
  final String? renewsAt;
  final bool hasSubscription;

  Subscription({
    required this.tier,
    required this.quotaBytes,
    required this.usedBytes,
    required this.status,
    required this.renewsAt,
    required this.hasSubscription,
  });

  factory Subscription.fromJson(Map<String, dynamic> j) => Subscription(
        tier: j['tier'] as String,
        quotaBytes: (j['quota_bytes'] as num).toInt(),
        usedBytes: (j['used_bytes'] as num).toInt(),
        status: j['status'] as String?,
        renewsAt: j['renews_at'] as String?,
        hasSubscription: (j['has_subscription'] as bool?) ?? false,
      );
}

class S3AccessKey {
  final int id;
  final String accessKey;
  final String? secretKey;
  final String? name;
  final String createdAt;
  final String? lastUsedAt;

  S3AccessKey({
    required this.id,
    required this.accessKey,
    required this.secretKey,
    required this.name,
    required this.createdAt,
    required this.lastUsedAt,
  });

  factory S3AccessKey.fromJson(Map<String, dynamic> j) => S3AccessKey(
        id: j['id'] as int,
        accessKey: j['access_key'] as String,
        secretKey: j['secret_key'] as String?,
        name: j['name'] as String?,
        createdAt: j['created_at'] as String,
        lastUsedAt: j['last_used_at'] as String?,
      );
}

class App {
  final int id;
  final String name;
  final String? description;
  final String? token;
  final String tokenPrefix;
  final String createdAt;
  final String? lastUsedAt;

  App({
    required this.id,
    required this.name,
    required this.description,
    required this.token,
    required this.tokenPrefix,
    required this.createdAt,
    required this.lastUsedAt,
  });

  factory App.fromJson(Map<String, dynamic> j) => App(
        id: j['id'] as int,
        name: j['name'] as String,
        description: j['description'] as String?,
        token: j['token'] as String?,
        tokenPrefix: j['token_prefix'] as String,
        createdAt: j['created_at'] as String,
        lastUsedAt: j['last_used_at'] as String?,
      );
}
