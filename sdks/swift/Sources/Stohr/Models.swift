import Foundation

public struct User: Codable, Sendable {
    public let id: Int
    public let email: String
    public let username: String
    public let name: String
    public let isOwner: Bool
    public let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, email, username, name
        case isOwner = "is_owner"
        case createdAt = "created_at"
    }
}

public struct AuthResult: Codable, Sendable {
    public let id: Int
    public let email: String
    public let username: String
    public let name: String
    public let isOwner: Bool
    public let token: String

    enum CodingKeys: String, CodingKey {
        case id, email, username, name, token
        case isOwner = "is_owner"
    }
}

public struct Folder: Codable, Sendable {
    public let id: Int
    public let name: String
    public let parentId: Int?
    public let kind: String?
    public let isPublic: Bool?
    public let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, name, kind
        case parentId = "parent_id"
        case isPublic = "is_public"
        case createdAt = "created_at"
    }
}

public struct StohrFile: Codable, Sendable {
    public let id: Int
    public let name: String
    public let mime: String
    public let size: Int
    public let folderId: Int?
    public let version: Int
    public let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, name, mime, size, version
        case folderId = "folder_id"
        case createdAt = "created_at"
    }
}

public struct Share: Codable, Sendable {
    public let id: Int
    public let token: String
    public let expiresAt: String?
    public let createdAt: String
    public let fileId: Int

    enum CodingKeys: String, CodingKey {
        case id, token
        case expiresAt = "expires_at"
        case createdAt = "created_at"
        case fileId = "file_id"
    }
}

public struct Subscription: Codable, Sendable {
    public let tier: String
    public let quotaBytes: Int
    public let usedBytes: Int
    public let status: String?
    public let renewsAt: String?
    public let hasSubscription: Bool

    enum CodingKeys: String, CodingKey {
        case tier, status
        case quotaBytes = "quota_bytes"
        case usedBytes = "used_bytes"
        case renewsAt = "renews_at"
        case hasSubscription = "has_subscription"
    }
}

public struct S3AccessKey: Codable, Sendable {
    public let id: Int
    public let accessKey: String
    public let secretKey: String?
    public let name: String?
    public let createdAt: String
    public let lastUsedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, name
        case accessKey = "access_key"
        case secretKey = "secret_key"
        case createdAt = "created_at"
        case lastUsedAt = "last_used_at"
    }
}

public struct StohrError: Error, Sendable {
    public let status: Int
    public let message: String
    public let body: Data?
}
