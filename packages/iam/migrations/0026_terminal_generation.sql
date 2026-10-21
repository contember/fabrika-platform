-- The generation of a terminal (ADR-0067 §5). SQLite/D1 dialect; `../migrations-postgres/0026_terminal_generation.sql` states
-- the same outcome.
--
-- A release or a revocation of a terminal ends every session and identification of its current generation. A release
-- increments `terminals.generation`; an identification records the generation it was opened in, a login on the
-- terminal the generation of its identification, and a session is valid only while that is still the terminal's. So an
-- assertion that raced a release opens a login that is already invalid, whichever transaction commits first.
ALTER TABLE terminals ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;

ALTER TABLE terminal_identifications ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sessions ADD COLUMN terminal_generation INTEGER;
