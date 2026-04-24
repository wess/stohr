ALTER TABLE folders ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE files ADD COLUMN deleted_at TIMESTAMPTZ;
CREATE INDEX idx_folders_deleted ON folders(deleted_at);
CREATE INDEX idx_files_deleted ON files(deleted_at);
