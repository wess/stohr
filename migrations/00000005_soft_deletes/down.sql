DROP INDEX idx_folders_deleted;
DROP INDEX idx_files_deleted;
ALTER TABLE folders DROP COLUMN deleted_at;
ALTER TABLE files DROP COLUMN deleted_at;
