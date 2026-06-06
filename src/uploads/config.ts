// Resumable upload policy. Chunks are fixed at 5MB — the S3 multipart minimum
// part size (every part except the last must be >= 5MB), so the same number
// works for both the S3 and local drivers without special-casing.
export const CHUNK_SIZE = 5 * 1024 * 1024

// Sessions live for 24h. The sweep aborts the S3 multipart upload and deletes
// the row once expires_at has passed; clients must finalize within the window.
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000
