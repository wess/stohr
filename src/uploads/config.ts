// Resumable upload policy. Chunks are fixed at 5MB — the S3 multipart minimum
// part size (every part except the last must be >= 5MB), so the same number
// works for both the S3 and local drivers without special-casing.
export const CHUNK_SIZE = 5 * 1024 * 1024

// Sessions live for 24h. The sweep aborts the S3 multipart upload and deletes
// the row once expires_at has passed; clients must finalize within the window.
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000

// Same cap src/server.ts applies to a single request body (MAX_UPLOAD_BYTES).
// A chunked upload is one file split across requests, so its declared total is
// held to the same number; otherwise the chunk path is a way around the cap.
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? "") || 1024 * 1024 * 1024

// Open sessions per user. Every one of them reserves its declared size
// against the quota, so an unbounded count is an unbounded reservation.
export const MAX_SESSIONS_PER_USER = 16
