import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart' as testing;
import 'package:test/test.dart';

import 'package:stohr/stohr.dart';

void main() {
  http.Client mockClient(List<dynamic> responses) {
    var i = 0;
    return testing.MockClient((req) async {
      final r = responses[i++];
      final body = r is String ? r : jsonEncode(r);
      return http.Response(body, r is Map && r['__status'] is int ? r['__status'] as int : 200);
    });
  }

  group('auth', () {
    test('login stores token', () async {
      final client = StohrClient(
        baseUrl: 'https://test.local/api',
        client: mockClient([
          {
            'id': 1,
            'email': 'a@b.com',
            'username': 'alice',
            'name': 'Alice',
            'is_owner': false,
            'created_at': 'now',
            'token': 'tkn',
          }
        ]),
      );
      final res = await client.login('alice', 'secret');
      expect(res.token, 'tkn');
      expect(client.token, 'tkn');
    });

    test('error throws StohrError', () async {
      final client = StohrClient(
        baseUrl: 'https://test.local/api',
        client: testing.MockClient((req) async =>
            http.Response(jsonEncode({'error': 'Invalid credentials'}), 401)),
      );
      expect(() => client.login('x', 'y'), throwsA(isA<StohrError>()));
    });
  });

  group('folders', () {
    test('list folders', () async {
      final client = StohrClient(
        baseUrl: 'https://test.local/api',
        token: 't',
        client: mockClient([
          [
            {'id': 1, 'name': 'Photos', 'parent_id': null, 'created_at': 'now'}
          ]
        ]),
      );
      final folders = await client.listFolders();
      expect(folders, hasLength(1));
      expect(folders.first.name, 'Photos');
    });

    test('create photos folder', () async {
      final client = StohrClient(
        baseUrl: 'https://test.local/api',
        token: 't',
        client: mockClient([
          {
            'id': 7,
            'name': 'Italy',
            'parent_id': null,
            'kind': 'photos',
            'is_public': true,
            'created_at': 'now',
          }
        ]),
      );
      final folder = await client.createFolder('Italy', kind: 'photos', isPublic: true);
      expect(folder.id, 7);
      expect(folder.kind, 'photos');
    });
  });

  group('files', () {
    test('list files in folder', () async {
      final client = StohrClient(
        baseUrl: 'https://test.local/api',
        token: 't',
        client: mockClient([
          [
            {
              'id': 1,
              'name': 'a.txt',
              'mime': 'text/plain',
              'size': 5,
              'folder_id': 5,
              'version': 1,
              'created_at': 'now',
            }
          ]
        ]),
      );
      final files = await client.listFiles(folderId: 5);
      expect(files, hasLength(1));
      expect(files.first.size, 5);
    });

    test('download returns bytes', () async {
      final client = StohrClient(
        baseUrl: 'https://test.local/api',
        token: 't',
        client: testing.MockClient((req) async =>
            http.Response.bytes(Uint8List.fromList([1, 2, 3, 4]), 200)),
      );
      final bytes = await client.downloadFile(42);
      expect(bytes, [1, 2, 3, 4]);
    });
  });

  group('subscription + s3 keys', () {
    test('subscription returns usage', () async {
      final client = StohrClient(
        baseUrl: 'https://test.local/api',
        token: 't',
        client: mockClient([
          {
            'tier': 'pro',
            'quota_bytes': 268435456000,
            'used_bytes': 1024,
            'status': 'active',
            'renews_at': 'n',
            'has_subscription': true,
          }
        ]),
      );
      final sub = await client.subscription();
      expect(sub.tier, 'pro');
      expect(sub.usedBytes, 1024);
    });

    test('create s3 key returns secret', () async {
      final client = StohrClient(
        baseUrl: 'https://test.local/api',
        token: 't',
        client: mockClient([
          {
            'id': 1,
            'access_key': 'AKIA',
            'secret_key': 'shhh',
            'name': 'ci',
            'created_at': 'n',
            'last_used_at': null,
          }
        ]),
      );
      final key = await client.createS3Key(name: 'ci');
      expect(key.secretKey, 'shhh');
    });
  });
}
