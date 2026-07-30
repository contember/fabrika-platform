ALTER TABLE issues ADD COLUMN id TEXT;

CREATE UNIQUE INDEX idx_issues_id
	ON issues(id)
	WHERE id IS NOT NULL;
