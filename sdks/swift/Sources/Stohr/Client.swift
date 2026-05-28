import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public protocol HTTPSession: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
    func upload(for request: URLRequest, from bodyData: Data) async throws -> (Data, URLResponse)
}

extension URLSession: HTTPSession {
    public func upload(for request: URLRequest, from bodyData: Data) async throws -> (Data, URLResponse) {
        try await upload(for: request, from: bodyData, delegate: nil)
    }
}

public actor StohrClient {
    public let baseURL: URL
    private let session: HTTPSession
    private var token: String?

    public init(baseURL: URL = URL(string: "https://stohr.io/api")!, token: String? = nil, session: HTTPSession = URLSession.shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    public func setToken(_ t: String?) { token = t }
    public func currentToken() -> String? { token }

    private func makeRequest(_ method: String, _ path: String, body: Data? = nil, contentType: String? = "application/json") -> URLRequest {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = method
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body, let contentType {
            req.setValue(contentType, forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        return req
    }

    private func send<T: Decodable>(_ method: String, _ path: String, body: Encodable? = nil, expecting: T.Type) async throws -> T {
        var data: Data?
        if let body {
            let encoder = JSONEncoder()
            encoder.keyEncodingStrategy = .convertToSnakeCase
            data = try encoder.encode(AnyEncodable(body))
        }
        let req = makeRequest(method, path, body: data)
        let (responseData, response) = try await session.data(for: req)
        try Self.assertOK(responseData, response)
        let decoder = JSONDecoder()
        return try decoder.decode(T.self, from: responseData)
    }

    private static func assertOK(_ data: Data, _ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { return }
        if (200..<300).contains(http.statusCode) {
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let err = obj["error"] as? String {
                throw StohrError(status: http.statusCode, message: err, body: data)
            }
            return
        }
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let err = obj["error"] as? String {
            throw StohrError(status: http.statusCode, message: err, body: data)
        }
        throw StohrError(status: http.statusCode, message: "HTTP \(http.statusCode)", body: data)
    }

    // ── auth ──────────────────────────────────────────

    public func login(identity: String, password: String) async throws -> AuthResult {
        let res: AuthResult = try await send("POST", "login", body: ["identity": identity, "password": password], expecting: AuthResult.self)
        token = res.token
        return res
    }

    public func signup(name: String, username: String, email: String, password: String, inviteToken: String? = nil) async throws -> AuthResult {
        var body: [String: String] = ["name": name, "username": username, "email": email, "password": password]
        if let inviteToken { body["invite_token"] = inviteToken }
        let res: AuthResult = try await send("POST", "signup", body: body, expecting: AuthResult.self)
        token = res.token
        return res
    }

    // ── me ────────────────────────────────────────────

    public func me() async throws -> User { try await send("GET", "me", expecting: User.self) }
    public func usage() async throws -> Usage { try await send("GET", "me/usage", expecting: Usage.self) }

    // ── folders ───────────────────────────────────────

    public func listFolders(parentId: Int? = nil) async throws -> [Folder] {
        let path = "folders?parent_id=\(parentId.map(String.init) ?? "null")"
        return try await send("GET", path, expecting: [Folder].self)
    }

    public func createFolder(name: String, parentId: Int? = nil, kind: String? = nil, isPublic: Bool? = nil) async throws -> Folder {
        struct Body: Encodable {
            let name: String
            let parent_id: Int?
            let kind: String?
            let is_public: Bool?
        }
        return try await send("POST", "folders", body: Body(name: name, parent_id: parentId, kind: kind, is_public: isPublic), expecting: Folder.self)
    }

    public func deleteFolder(_ id: Int) async throws {
        struct Empty: Decodable {}
        let _: Empty = try await send("DELETE", "folders/\(id)", expecting: Empty.self)
    }

    // ── files ─────────────────────────────────────────

    public func listFiles(folderId: Int? = nil, query: String? = nil) async throws -> [StohrFile] {
        let qs = query.map { "q=\($0.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")" }
            ?? "folder_id=\(folderId.map(String.init) ?? "null")"
        return try await send("GET", "files?\(qs)", expecting: [StohrFile].self)
    }

    public func uploadFile(data: Data, name: String, mime: String = "application/octet-stream", folderId: Int? = nil) async throws -> [StohrFile] {
        let boundary = "----stohr-\(UUID().uuidString)"
        var body = Data()
        let crlf = "\r\n"
        if let folderId {
            body.append("--\(boundary)\(crlf)".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"folder_id\"\(crlf)\(crlf)".data(using: .utf8)!)
            body.append("\(folderId)\(crlf)".data(using: .utf8)!)
        }
        body.append("--\(boundary)\(crlf)".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"\(name)\"; filename=\"\(name)\"\(crlf)".data(using: .utf8)!)
        body.append("Content-Type: \(mime)\(crlf)\(crlf)".data(using: .utf8)!)
        body.append(data)
        body.append("\(crlf)--\(boundary)--\(crlf)".data(using: .utf8)!)

        var req = URLRequest(url: baseURL.appendingPathComponent("files"))
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }

        let (responseData, response) = try await session.upload(for: req, from: body)
        try Self.assertOK(responseData, response)
        return try JSONDecoder().decode([StohrFile].self, from: responseData)
    }

    public func downloadFile(_ id: Int) async throws -> Data {
        let req = makeRequest("GET", "files/\(id)/download", body: nil, contentType: nil)
        let (data, response) = try await session.data(for: req)
        try Self.assertOK(data, response)
        return data
    }

    public func deleteFile(_ id: Int) async throws {
        struct Empty: Decodable {}
        let _: Empty = try await send("DELETE", "files/\(id)", expecting: Empty.self)
    }

    // ── photo backup ─────────────────────────────────
    //
    // Mobile-first protocol. See docs/PHOTO-BACKUP.md.
    //   1. initPhotoBackup() once at launch.
    //   2. photoBackupManifest(localIds) → server-known IDs (skip those).
    //   3. uploadPhoto(...) per remaining ID. Idempotent: retry-safe.

    public struct PhotoBackupInit: Decodable { public let folder_id: Int; public let uploaded: Int; public let bytes: Int64 }
    public struct PhotoUploadResult: Decodable {
        public let id: Int; public let name: String; public let mime: String
        public let folder_id: Int?; public let version: Int; public let created_at: String
        public let deduped: Bool
    }

    public func initPhotoBackup() async throws -> PhotoBackupInit {
        struct Empty: Encodable {}
        return try await send("POST", "photos/init", body: Empty(), expecting: PhotoBackupInit.self)
    }

    public func photoBackupManifest(assetIds: [String]) async throws -> [String] {
        struct Body: Encodable { let asset_ids: [String] }
        struct Result: Decodable { let known: [String] }
        return try await send("POST", "photos/manifest", body: Body(asset_ids: assetIds), expecting: Result.self).known
    }

    public func uploadPhoto(assetId: String, data: Data, name: String, mime: String, capturedAt: Date? = nil) async throws -> PhotoUploadResult {
        let boundary = "----stohr-\(UUID().uuidString)"
        var body = Data()
        let crlf = "\r\n"

        func appendField(_ field: String, _ value: String) {
            body.append("--\(boundary)\(crlf)".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(field)\"\(crlf)\(crlf)".data(using: .utf8)!)
            body.append("\(value)\(crlf)".data(using: .utf8)!)
        }

        appendField("asset_id", assetId)
        appendField("mime", mime)
        if let capturedAt {
            let fmt = ISO8601DateFormatter()
            fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            appendField("captured_at", fmt.string(from: capturedAt))
        }

        body.append("--\(boundary)\(crlf)".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\(crlf)".data(using: .utf8)!)
        body.append("Content-Type: \(mime)\(crlf)\(crlf)".data(using: .utf8)!)
        body.append(data)
        body.append("\(crlf)--\(boundary)--\(crlf)".data(using: .utf8)!)

        var req = URLRequest(url: baseURL.appendingPathComponent("photos/upload"))
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }

        let (responseData, response) = try await session.upload(for: req, from: body)
        try Self.assertOK(responseData, response)
        return try JSONDecoder().decode(PhotoUploadResult.self, from: responseData)
    }

    // ── shares ───────────────────────────────────────

    public func createShare(fileId: Int, expiresInSeconds: Int) async throws -> Share {
        struct Body: Encodable { let file_id: Int; let expires_in: Int }
        return try await send("POST", "shares", body: Body(file_id: fileId, expires_in: expiresInSeconds), expecting: Share.self)
    }

    // ── s3 keys ──────────────────────────────────────

    public func listS3Keys() async throws -> [S3AccessKey] { try await send("GET", "me/s3-keys", expecting: [S3AccessKey].self) }

    public func createS3Key(name: String? = nil) async throws -> S3AccessKey {
        struct Body: Encodable { let name: String? }
        return try await send("POST", "me/s3-keys", body: Body(name: name), expecting: S3AccessKey.self)
    }

    public func revokeS3Key(_ id: Int) async throws {
        struct Empty: Decodable {}
        let _: Empty = try await send("DELETE", "me/s3-keys/\(id)", expecting: Empty.self)
    }
}

// AnyEncodable shim so we can pass type-erased dicts as body
private struct AnyEncodable: Encodable {
    let value: Encodable
    init(_ value: Encodable) { self.value = value }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}
