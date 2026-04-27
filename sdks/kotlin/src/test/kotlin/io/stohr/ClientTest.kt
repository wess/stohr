package io.stohr

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull

class ClientTest {

    private fun jsonEngine(status: HttpStatusCode, body: String) = MockEngine { _ ->
        respond(content = body, status = status, headers = headersOf("Content-Type", "application/json"))
    }

    @Test
    fun loginStoresToken() = runTest {
        val engine = jsonEngine(
            HttpStatusCode.OK,
            """{"id":1,"email":"a@b.com","username":"alice","name":"Alice","is_owner":false,"created_at":"now","token":"tkn"}"""
        )
        val client = StohrClient(baseUrl = "https://test.local/api", engine = engine)
        val res = client.login("alice", "secret")
        assertEquals("tkn", res.token)
        assertEquals("tkn", client.token())
    }

    @Test
    fun listFolders() = runTest {
        val engine = jsonEngine(
            HttpStatusCode.OK,
            """[{"id":1,"name":"Photos","parent_id":null,"created_at":"now"}]"""
        )
        val client = StohrClient(baseUrl = "https://test.local/api", token = "t", engine = engine)
        val folders = client.listFolders()
        assertEquals(1, folders.size)
        assertEquals("Photos", folders[0].name)
    }

    @Test
    fun createPhotosFolder() = runTest {
        val engine = jsonEngine(
            HttpStatusCode.OK,
            """{"id":7,"name":"Italy","parent_id":null,"kind":"photos","is_public":true,"created_at":"now"}"""
        )
        val client = StohrClient(baseUrl = "https://test.local/api", token = "t", engine = engine)
        val folder = client.createFolder("Italy", kind = "photos", isPublic = true)
        assertEquals(7, folder.id)
        assertEquals("photos", folder.kind)
    }

    @Test
    fun errorThrowsStohrError() = runTest {
        val engine = jsonEngine(HttpStatusCode.Unauthorized, """{"error":"Invalid credentials"}""")
        val client = StohrClient(baseUrl = "https://test.local/api", engine = engine)
        val ex = assertFailsWith<StohrError> { client.login("x", "y") }
        assertEquals(401, ex.status)
        assertEquals("Invalid credentials", ex.message)
    }

    @Test
    fun createS3Key() = runTest {
        val engine = jsonEngine(
            HttpStatusCode.OK,
            """{"id":1,"access_key":"AKIA","secret_key":"shhh","name":"ci","created_at":"n","last_used_at":null}"""
        )
        val client = StohrClient(baseUrl = "https://test.local/api", token = "t", engine = engine)
        val key = client.createS3Key("ci")
        assertEquals("shhh", key.secretKey)
        assertNotNull(key.secretKey)
    }
}
