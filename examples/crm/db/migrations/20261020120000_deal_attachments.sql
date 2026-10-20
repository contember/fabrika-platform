-- A deal's attachments as rows with a file column, which replace the `attachments` file collection. The framework's
-- 0008 migration copied the collection's files into fabrika_files under their own ids; each one becomes a row here,
-- under the same id.

CREATE TABLE deal_attachments (
	id UUID PRIMARY KEY,
	deal_id UUID NOT NULL,
	company_id UUID NOT NULL,
	org_id TEXT NOT NULL,
	file UUID NOT NULL REFERENCES fabrika_files (id),
	name TEXT NOT NULL,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	FOREIGN KEY (deal_id, company_id, org_id) REFERENCES deals (id, company_id, org_id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX deal_attachments_deal ON deal_attachments (deal_id);
CREATE INDEX deal_attachments_file ON deal_attachments (file);

-- The files an older instance, still serving during the rollout, wrote after 0008 are copied too, so every row the
-- insert reads has its fabrika_files row: the rows not deleted, not pending, that still have a deal.
SELECT fabrika_files_copy_legacy('attachments');
INSERT INTO deal_attachments (id, deal_id, company_id, org_id, file, name, created_by, created_at)
SELECT s.id, s.owner_id, s.company_id, s.org_id, s.id, COALESCE(s.original_name, 'attachment'), s.created_by, s.created_at
FROM fabrika_files_attachments s
WHERE s.owner_id IS NOT NULL AND s.deleted_at IS NULL AND s.status <> 'pending';
