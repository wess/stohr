import XCTest
@testable import Stohr

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

actor MockSession: HTTPSession {
    var responses: [(Int, Data)]
    private(set) var calls: [(String, URL, Data?)] = []

    init(_ responses: [(Int, Data)]) { self.responses = responses }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let (status, body) = responses.removeFirst()
        calls.append((request.httpMethod ?? "GET", request.url!, request.httpBody))
        return (body, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }

    func upload(for request: URLRequest, from bodyData: Data) async throws -> (Data, URLResponse) {
        let (status, body) = responses.removeFirst()
        calls.append((request.httpMethod ?? "POST", request.url!, bodyData))
        return (body, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

final class StohrTests: XCTestCase {
    func testLoginStoresToken() async throws {
        let json = """
        {"id":1,"email":"a@b.com","username":"alice","name":"Alice","is_owner":false,"token":"tkn"}
        """
        let session = MockSession([(200, json.data(using: .utf8)!)])
        let client = StohrClient(baseURL: URL(string: "https://test.local/api")!, session: session)
        let res = try await client.login(identity: "alice", password: "secret")
        XCTAssertEqual(res.token, "tkn")
        let token = await client.currentToken()
        XCTAssertEqual(token, "tkn")
    }

    func testListFolders() async throws {
        let json = """
        [{"id":1,"name":"Photos","parent_id":null,"created_at":"now"}]
        """
        let session = MockSession([(200, json.data(using: .utf8)!)])
        let client = StohrClient(baseURL: URL(string: "https://test.local/api")!, token: "t", session: session)
        let folders = try await client.listFolders(parentId: nil)
        XCTAssertEqual(folders.count, 1)
        XCTAssertEqual(folders.first?.name, "Photos")
    }

    func testCreatePhotosFolder() async throws {
        let json = """
        {"id":7,"name":"Italy","parent_id":null,"kind":"photos","is_public":true,"created_at":"now"}
        """
        let session = MockSession([(200, json.data(using: .utf8)!)])
        let client = StohrClient(baseURL: URL(string: "https://test.local/api")!, token: "t", session: session)
        let folder = try await client.createFolder(name: "Italy", kind: "photos", isPublic: true)
        XCTAssertEqual(folder.id, 7)
        XCTAssertEqual(folder.kind, "photos")
    }

    func testErrorThrowsStohrError() async {
        let json = #"{"error":"Invalid credentials"}"#
        let session = MockSession([(401, json.data(using: .utf8)!)])
        let client = StohrClient(baseURL: URL(string: "https://test.local/api")!, session: session)
        do {
            _ = try await client.login(identity: "x", password: "y")
            XCTFail("expected throw")
        } catch let error as StohrError {
            XCTAssertEqual(error.status, 401)
            XCTAssertEqual(error.message, "Invalid credentials")
        } catch {
            XCTFail("wrong error type")
        }
    }

    func testCreateS3Key() async throws {
        let json = """
        {"id":1,"access_key":"AKIA","secret_key":"shhh","name":"ci","created_at":"n","last_used_at":null}
        """
        let session = MockSession([(200, json.data(using: .utf8)!)])
        let client = StohrClient(baseURL: URL(string: "https://test.local/api")!, token: "t", session: session)
        let key = try await client.createS3Key(name: "ci")
        XCTAssertEqual(key.secretKey, "shhh")
    }
}
