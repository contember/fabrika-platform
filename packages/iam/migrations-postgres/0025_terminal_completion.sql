-- The completion of a terminal identification (ADR-0067 §3). Postgres dialect;
-- `../migrations/0025_terminal_completion.sql` states the same outcome.
--
-- An assertion no longer hands the application a code. It records the login it opened in `session_id`, and the
-- terminal's own browser completes the identification at IAM (`completed_at`), which only then issues the code.
-- `session_id` has no foreign key: the assertion's batch writes it before the login row, and the completion reads the
-- login through the session validity rule, which answers nothing for a login that is gone.
ALTER TABLE terminal_identifications ADD COLUMN session_id TEXT;

ALTER TABLE terminal_identifications ADD COLUMN completed_at INTEGER;
