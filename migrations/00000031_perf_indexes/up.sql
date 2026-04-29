CREATE INDEX idx_files_user_active   ON files(user_id, folder_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_files_user_trashed  ON files(user_id)             WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_files_folder_active ON files(folder_id, name)     WHERE deleted_at IS NULL;

CREATE INDEX idx_folders_user_active   ON folders(user_id, parent_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_folders_user_trashed  ON folders(user_id)            WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_folders_parent_active ON folders(parent_id, name)    WHERE deleted_at IS NULL;

CREATE INDEX idx_file_versions_file_size ON file_versions(file_id) INCLUDE (size);
