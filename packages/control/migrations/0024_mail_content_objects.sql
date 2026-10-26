-- A relayed message's content may live in an object instead of its row: a D1 row holds at most 2,000,000 bytes, and the
-- relay accepts more. `content_ref` names that object; a row keeps its content in `content` or in `content_ref`, never both.
ALTER TABLE mail_messages ADD COLUMN content_ref TEXT;

-- An object written before its message's row, until the row that names it commits. One older than a recording takes
-- is collected with its object by maintenance: the row was never written, or a message under the same key won.
CREATE TABLE mail_content_uploads (
	message_id TEXT PRIMARY KEY,
	object_key TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX idx_mail_content_uploads_created ON mail_content_uploads(created_at);
