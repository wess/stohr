package io.stohr

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class User(
    val id: Int,
    val email: String,
    val username: String,
    val name: String,
    @SerialName("is_owner") val isOwner: Boolean = false,
    @SerialName("created_at") val createdAt: String,
)

@Serializable
data class AuthResult(
    val id: Int,
    val email: String,
    val username: String,
    val name: String,
    @SerialName("is_owner") val isOwner: Boolean = false,
    val token: String,
)

@Serializable
data class Folder(
    val id: Int,
    val name: String,
    @SerialName("parent_id") val parentId: Int? = null,
    val kind: String? = null,
    @SerialName("is_public") val isPublic: Boolean? = null,
    @SerialName("created_at") val createdAt: String,
)

@Serializable
data class StohrFile(
    val id: Int,
    val name: String,
    val mime: String,
    val size: Long,
    @SerialName("folder_id") val folderId: Int? = null,
    val version: Int,
    @SerialName("created_at") val createdAt: String,
)

@Serializable
data class Share(
    val id: Int,
    val token: String,
    @SerialName("expires_at") val expiresAt: String? = null,
    @SerialName("created_at") val createdAt: String,
    @SerialName("file_id") val fileId: Int,
)

@Serializable
data class Usage(
    @SerialName("quota_bytes") val quotaBytes: Long,
    @SerialName("used_bytes") val usedBytes: Long,
    @SerialName("active_bytes") val activeBytes: Long,
    @SerialName("trash_bytes") val trashBytes: Long,
    @SerialName("version_bytes") val versionBytes: Long,
)

@Serializable
data class S3AccessKey(
    val id: Int,
    @SerialName("access_key") val accessKey: String,
    @SerialName("secret_key") val secretKey: String? = null,
    val name: String? = null,
    @SerialName("created_at") val createdAt: String,
    @SerialName("last_used_at") val lastUsedAt: String? = null,
)

class StohrError(
    val status: Int,
    message: String,
    val body: String? = null,
) : Exception(message)
