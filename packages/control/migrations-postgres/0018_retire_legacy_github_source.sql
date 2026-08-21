-- Retire the v1 source credential path (ADR-0039). The singleton table was durable compatibility
-- evidence for a credential that no longer exists anywhere; `keyed-v2` is now the only transport.
--
-- The `transport_kind` CHECK still names `legacy-v1`, matching the SQLite schema, where narrowing it
-- would need a full table rebuild. No writer can produce the value any more — `publishConnection`
-- writes the literal and `parseTransportKind` refuses it on read.

DELETE FROM github_source_setup_attempts WHERE setup_kind = 'adoption';
DELETE FROM github_source_connections_keyed WHERE transport_kind = 'legacy-v1';

DROP INDEX idx_github_source_connections_keyed_legacy;

DROP TABLE github_source_connections;
