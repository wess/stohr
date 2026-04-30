DROP TABLE IF EXISTS file_embeddings;
-- We do not drop the vector extension — other tables may depend on it
-- in the future, and dropping requires no dependent rows. Operators
-- can DROP EXTENSION vector CASCADE manually if removing pgvector.
