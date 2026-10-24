-- Whether the launcher of a dev environment still talks to Control (ADR-0049): launcher_seen_at is its last accepted
-- wait or report, launcher_refused why Control could not read the requests of the current container, and
-- service_started_at when a start after an idle stop booted that container again.
ALTER TABLE dev_environments ADD COLUMN launcher_seen_at INTEGER;
ALTER TABLE dev_environments ADD COLUMN launcher_refused TEXT;
ALTER TABLE dev_environments ADD COLUMN service_started_at INTEGER;
