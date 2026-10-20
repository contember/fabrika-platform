-- A note's attachments as rows with a file column, which replace the `attachments` file collection. The framework's
-- 0008 migration copied the collection's files into fabrika_files under their own ids; each one becomes a row here,
-- under the same id. Deleting a note deletes its rows, and the sweep then deletes the files no row references.

CREATE TABLE note_attachments (
	id UUID PRIMARY KEY,
	note_id UUID NOT NULL,
	workspace_id TEXT NOT NULL,
	file UUID NOT NULL REFERENCES fabrika_files (id),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	FOREIGN KEY (note_id, workspace_id) REFERENCES notes (id, workspace_id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX note_attachments_note ON note_attachments (note_id);
CREATE INDEX note_attachments_file ON note_attachments (file);

-- The files an older instance, still serving during the rollout, wrote after 0008 are copied too, so every row the
-- insert reads has its fabrika_files row: the rows not deleted, not pending, that still have a note.
SELECT fabrika_files_copy_legacy('attachments');
INSERT INTO note_attachments (id, note_id, workspace_id, file, created_at)
SELECT s.id, s.owner_id, s.workspace_id, s.id, s.created_at
FROM fabrika_files_attachments s
WHERE s.owner_id IS NOT NULL AND s.deleted_at IS NULL AND s.status <> 'pending';
