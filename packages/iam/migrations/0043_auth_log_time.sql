-- Operations' security alerts read `auth_log` by `created_at` every minute (`AuditRepository.signInSignals`). SQLite/D1
-- dialect; `../migrations-postgres/0043_auth_log_time.sql` states the same outcome. Without this index each read scans
-- the whole retention period, and so does the daily prune.
CREATE INDEX idx_auth_log_time ON auth_log(created_at);
