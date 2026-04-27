package io.stohr

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.delete
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.client.statement.readRawBytes
import io.ktor.http.ContentType
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

class StohrClient(
    private val baseUrl: String = "https://stohr.io/api",
    private var token: String? = null,
    engine: HttpClientEngine? = null,
) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    private val http: HttpClient = if (engine != null) {
        HttpClient(engine) { install(ContentNegotiation) { json(json) } }
    } else {
        HttpClient(CIO) { install(ContentNegotiation) { json(json) } }
    }

    fun setToken(t: String?) { token = t }
    fun token(): String? = token

    private suspend fun assertOk(resp: HttpResponse): String {
        val text = resp.bodyAsText()
        val errorMsg = runCatching {
            (json.parseToJsonElement(text) as? JsonObject)?.get("error")?.let {
                (it as? JsonPrimitive)?.contentOrNull
            }
        }.getOrNull()
        if (resp.status.value !in 200..299 || errorMsg != null) {
            throw StohrError(resp.status.value, errorMsg ?: "HTTP ${resp.status.value}", text)
        }
        return text
    }

    private fun authHeader(): String? = token?.let { "Bearer $it" }

    // ── auth ──────────────────────────────────────────

    suspend fun login(identity: String, password: String): AuthResult {
        val resp = http.post("$baseUrl/login") {
            contentType(ContentType.Application.Json)
            setBody(buildJsonStr(mapOf("identity" to identity, "password" to password)))
        }
        val text = assertOk(resp)
        val parsed = json.decodeFromString<AuthResult>(AuthResult.serializer(), text)
        token = parsed.token
        return parsed
    }

    suspend fun signup(
        name: String, username: String, email: String, password: String, inviteToken: String? = null,
    ): AuthResult {
        val body = mutableMapOf("name" to name, "username" to username, "email" to email, "password" to password)
        if (inviteToken != null) body["invite_token"] = inviteToken
        val resp = http.post("$baseUrl/signup") {
            contentType(ContentType.Application.Json)
            setBody(buildJsonStr(body))
        }
        val text = assertOk(resp)
        val parsed = json.decodeFromString<AuthResult>(AuthResult.serializer(), text)
        token = parsed.token
        return parsed
    }

    // ── me ────────────────────────────────────────────

    suspend fun me(): User {
        val resp = http.get("$baseUrl/me") { authHeader()?.let { header(HttpHeaders.Authorization, it) } }
        return json.decodeFromString(User.serializer(), assertOk(resp))
    }

    suspend fun subscription(): Subscription {
        val resp = http.get("$baseUrl/me/subscription") { authHeader()?.let { header(HttpHeaders.Authorization, it) } }
        return json.decodeFromString(Subscription.serializer(), assertOk(resp))
    }

    // ── folders ───────────────────────────────────────

    suspend fun listFolders(parentId: Int? = null): List<Folder> {
        val pid = parentId?.toString() ?: "null"
        val resp = http.get("$baseUrl/folders?parent_id=$pid") { authHeader()?.let { header(HttpHeaders.Authorization, it) } }
        return json.decodeFromString(ListSerializer(Folder.serializer()), assertOk(resp))
    }

    suspend fun createFolder(name: String, parentId: Int? = null, kind: String? = null, isPublic: Boolean? = null): Folder {
        val body = buildString {
            append("{\"name\":${quote(name)}")
            append(",\"parent_id\":${parentId ?: "null"}")
            if (kind != null) append(",\"kind\":${quote(kind)}")
            if (isPublic != null) append(",\"is_public\":$isPublic")
            append("}")
        }
        val resp = http.post("$baseUrl/folders") {
            authHeader()?.let { header(HttpHeaders.Authorization, it) }
            contentType(ContentType.Application.Json)
            setBody(body)
        }
        return json.decodeFromString(Folder.serializer(), assertOk(resp))
    }

    suspend fun deleteFolder(id: Int) {
        val resp = http.delete("$baseUrl/folders/$id") { authHeader()?.let { header(HttpHeaders.Authorization, it) } }
        assertOk(resp)
    }

    // ── files ─────────────────────────────────────────

    suspend fun listFiles(folderId: Int? = null, query: String? = null): List<StohrFile> {
        val qs = query?.let { "q=${java.net.URLEncoder.encode(it, "UTF-8")}" } ?: "folder_id=${folderId ?: "null"}"
        val resp = http.get("$baseUrl/files?$qs") { authHeader()?.let { header(HttpHeaders.Authorization, it) } }
        return json.decodeFromString(ListSerializer(StohrFile.serializer()), assertOk(resp))
    }

    suspend fun uploadFile(bytes: ByteArray, name: String, mime: String = "application/octet-stream", folderId: Int? = null): List<StohrFile> {
        val resp = http.post("$baseUrl/files") {
            authHeader()?.let { header(HttpHeaders.Authorization, it) }
            setBody(MultiPartFormDataContent(formData {
                append(name, bytes, Headers.build {
                    append(HttpHeaders.ContentType, mime)
                    append(HttpHeaders.ContentDisposition, "filename=\"$name\"")
                })
                if (folderId != null) append("folder_id", folderId.toString())
            }))
        }
        return json.decodeFromString(ListSerializer(StohrFile.serializer()), assertOk(resp))
    }

    suspend fun downloadFile(id: Int): ByteArray {
        val resp = http.get("$baseUrl/files/$id/download") { authHeader()?.let { header(HttpHeaders.Authorization, it) } }
        if (resp.status != HttpStatusCode.OK) {
            throw StohrError(resp.status.value, "HTTP ${resp.status.value}", null)
        }
        return resp.readRawBytes()
    }

    suspend fun deleteFile(id: Int) {
        val resp = http.delete("$baseUrl/files/$id") { authHeader()?.let { header(HttpHeaders.Authorization, it) } }
        assertOk(resp)
    }

    // ── shares ────────────────────────────────────────

    suspend fun createShare(fileId: Int, expiresInSeconds: Int? = null): Share {
        val body = buildString {
            append("{\"file_id\":$fileId")
            if (expiresInSeconds != null) append(",\"expires_in\":$expiresInSeconds")
            append("}")
        }
        val resp = http.post("$baseUrl/shares") {
            authHeader()?.let { header(HttpHeaders.Authorization, it) }
            contentType(ContentType.Application.Json)
            setBody(body)
        }
        return json.decodeFromString(Share.serializer(), assertOk(resp))
    }

    // ── s3 keys ───────────────────────────────────────

    suspend fun listS3Keys(): List<S3AccessKey> {
        val resp = http.get("$baseUrl/me/s3-keys") { authHeader()?.let { header(HttpHeaders.Authorization, it) } }
        return json.decodeFromString(ListSerializer(S3AccessKey.serializer()), assertOk(resp))
    }

    suspend fun createS3Key(name: String? = null): S3AccessKey {
        val body = name?.let { "{\"name\":${quote(it)}}" } ?: "{}"
        val resp = http.post("$baseUrl/me/s3-keys") {
            authHeader()?.let { header(HttpHeaders.Authorization, it) }
            contentType(ContentType.Application.Json)
            setBody(body)
        }
        return json.decodeFromString(S3AccessKey.serializer(), assertOk(resp))
    }

    suspend fun revokeS3Key(id: Int) {
        val resp = http.delete("$baseUrl/me/s3-keys/$id") { authHeader()?.let { header(HttpHeaders.Authorization, it) } }
        assertOk(resp)
    }

    fun close() = http.close()

    private fun quote(s: String): String = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    private fun buildJsonStr(map: Map<String, Any?>): String =
        map.entries.joinToString(",", prefix = "{", postfix = "}") { (k, v) ->
            val value = when (v) {
                null -> "null"
                is String -> quote(v)
                is Boolean, is Number -> v.toString()
                else -> quote(v.toString())
            }
            "${quote(k)}:$value"
        }
}
