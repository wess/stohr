package io.stohr

import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.delete
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.get
import io.ktor.client.request.header
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
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

class StohrClient(
    private val baseUrl: String = "https://stohr.io/api",
    private var token: String? = null,
    engine: HttpClientEngine? = null,
) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val outJson = Json { encodeDefaults = true }

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
            setBody(jsonStr(mapOf("identity" to identity, "password" to password)))
        }
        val text = assertOk(resp)
        val parsed = json.decodeFromString<AuthResult>(AuthResult.serializer(), text)
        token = parsed.token
        return parsed
    }

    suspend fun signup(
        name: String, username: String, email: String, password: String, inviteToken: String? = null,
    ): AuthResult {
        val body = mutableMapOf<String, Any?>("name" to name, "username" to username, "email" to email, "password" to password)
        if (inviteToken != null) body["invite_token"] = inviteToken
        val resp = http.post("$baseUrl/signup") {
            contentType(ContentType.Application.Json)
            setBody(jsonStr(body))
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

    suspend fun usage(): Usage {
        val resp = http.get("$baseUrl/me/usage") { authHeader()?.let { header(HttpHeaders.Authorization, it) } }
        return json.decodeFromString(Usage.serializer(), assertOk(resp))
    }

    // ── folders ───────────────────────────────────────

    suspend fun listFolders(parentId: Int? = null): List<Folder> {
        val pid = parentId?.toString() ?: "null"
        val resp = http.get("$baseUrl/folders?parent_id=$pid") { authHeader()?.let { header(HttpHeaders.Authorization, it) } }
        return json.decodeFromString(ListSerializer(Folder.serializer()), assertOk(resp))
    }

    suspend fun createFolder(name: String, parentId: Int? = null, kind: String? = null, isPublic: Boolean? = null): Folder {
        val body = mutableMapOf<String, Any?>("name" to name, "parent_id" to parentId)
        if (kind != null) body["kind"] = kind
        if (isPublic != null) body["is_public"] = isPublic
        val resp = http.post("$baseUrl/folders") {
            authHeader()?.let { header(HttpHeaders.Authorization, it) }
            contentType(ContentType.Application.Json)
            setBody(jsonStr(body))
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

    // ── photo backup ──────────────────────────────────
    //
    // Mobile-first protocol. See docs/PHOTO-BACKUP.md.
    //   1. initPhotoBackup() once at app launch.
    //   2. photoBackupManifest(localIds) → server-known IDs (skip those).
    //   3. uploadPhoto(...) per remaining ID. Retry-safe.

    suspend fun initPhotoBackup(): Map<String, Any?> {
        val resp = http.post("$baseUrl/photos/init") {
            authHeader()?.let { header(HttpHeaders.Authorization, it) }
            contentType(ContentType.Application.Json); setBody("{}")
        }
        @Suppress("UNCHECKED_CAST")
        return json.decodeFromString(JsonElement.serializer(), assertOk(resp)).toMap()
    }

    suspend fun photoBackupManifest(assetIds: List<String>): List<String> {
        val resp = http.post("$baseUrl/photos/manifest") {
            authHeader()?.let { header(HttpHeaders.Authorization, it) }
            contentType(ContentType.Application.Json)
            setBody(jsonStr(mapOf("asset_ids" to assetIds)))
        }
        val parsed = json.decodeFromString(JsonElement.serializer(), assertOk(resp))
        return parsed.jsonObject["known"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList()
    }

    suspend fun uploadPhoto(
        assetId: String,
        bytes: ByteArray,
        name: String,
        mime: String,
        capturedAtIso: String? = null,
    ): Map<String, Any?> {
        val resp = http.post("$baseUrl/photos/upload") {
            authHeader()?.let { header(HttpHeaders.Authorization, it) }
            setBody(MultiPartFormDataContent(formData {
                append("asset_id", assetId)
                append("mime", mime)
                if (capturedAtIso != null) append("captured_at", capturedAtIso)
                append("file", bytes, Headers.build {
                    append(HttpHeaders.ContentType, mime)
                    append(HttpHeaders.ContentDisposition, "filename=\"$name\"")
                })
            }))
        }
        return json.decodeFromString(JsonElement.serializer(), assertOk(resp)).toMap()
    }

    private fun JsonElement.toMap(): Map<String, Any?> {
        val obj = (this as? JsonObject) ?: return emptyMap()
        return obj.mapValues { (_, v) ->
            when {
                v is JsonObject -> v.toMap()
                v is JsonArray -> v.map { it.unwrap() }
                v is JsonPrimitive -> v.unwrap()
                else -> null
            }
        }
    }

    private fun JsonElement.unwrap(): Any? = when (this) {
        is JsonNull -> null
        is JsonPrimitive -> contentOrNull
        is JsonObject -> toMap()
        is JsonArray -> map { it.unwrap() }
    }

    // ── shares ────────────────────────────────────────

    suspend fun createShare(fileId: Int, expiresInSeconds: Int): Share {
        val body = mapOf<String, Any?>("file_id" to fileId, "expires_in" to expiresInSeconds)
        val resp = http.post("$baseUrl/shares") {
            authHeader()?.let { header(HttpHeaders.Authorization, it) }
            contentType(ContentType.Application.Json)
            setBody(jsonStr(body))
        }
        return json.decodeFromString(Share.serializer(), assertOk(resp))
    }

    // ── s3 keys ───────────────────────────────────────

    suspend fun listS3Keys(): List<S3AccessKey> {
        val resp = http.get("$baseUrl/me/s3-keys") { authHeader()?.let { header(HttpHeaders.Authorization, it) } }
        return json.decodeFromString(ListSerializer(S3AccessKey.serializer()), assertOk(resp))
    }

    suspend fun createS3Key(name: String? = null): S3AccessKey {
        val body = if (name != null) jsonStr(mapOf("name" to name)) else "{}"
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

    private fun jsonStr(map: Map<String, Any?>): String {
        val obj = buildJsonObject {
            for ((k, v) in map) {
                when (v) {
                    null -> put(k, JsonNull)
                    is String -> put(k, v)
                    is Boolean -> put(k, v)
                    is Number -> put(k, v)
                    else -> put(k, v.toString())
                }
            }
        }
        return outJson.encodeToString(JsonObject.serializer(), obj)
    }
}
