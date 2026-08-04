-- Dev-only seed data for local clicking-through (NOT a migration, never deployed).
-- Apply to the local lopata D1:  bunx lopata d1 execute propustka --file seed.dev.sql
-- Re-runnable (ON CONFLICT DO NOTHING) — except `credential_grants` and `auth_log`, which have
-- no unique constraint to conflict on, so re-running duplicates their rows. `INSERT OR IGNORE`
-- behaved exactly the same way; this is not a regression.
--
-- Models the generic-scopes world (migration 0003): two sample apps declare their
-- own vocabulary, and grants exercise role-based, global, and inline shapes.
--
-- Portability (same rule as the migrations): `INSERT OR IGNORE` is SQLite-only and there is no
-- `unixepoch()` in Postgres, so this file uses `ON CONFLICT DO NOTHING` and FIXED unix-second
-- literals. The base "now" is 1782896400 = 2026-07-01T09:00:00Z; the offsets below preserve the
-- original relative spacing (…-90000, …-3600, …). They are frozen in the past on purpose —
-- nothing in dev depends on them being recent. The one value that must NOT age out is the share
-- link's expiry, so it is far-future rather than "now + 30 days".

-- ── App vocabulary (normally reconciled from each app's declared schema) ──────

-- opice scopes by organization/team; poplach scopes by project. The admin UI reads
-- app_scopes to offer real scope-type dropdowns per app.
INSERT INTO app_scopes (app, scope_type, label) VALUES
  ('opice',   'organization', 'Organization'),
  ('opice',   'team',         'Team'),
  ('poplach', 'project',      'Project')
  ON CONFLICT DO NOTHING;

-- Action catalogs. Inline grants and role permissions reference these strings.
INSERT INTO app_actions (app, action, description) VALUES
  ('opice',   'project.read',            'Read project data'),
  ('opice',   'project.settings.update', 'Update project settings'),
  ('opice',   'report.read',             'Read reports'),
  ('opice',   'report.export',           'Export reports'),
  ('poplach', 'project.read',            'Read project data'),
  ('poplach', 'report.read',             'Read reports'),
  ('poplach', 'report.export',           'Export reports')
  ON CONFLICT DO NOTHING;

-- Roles. origin='app' are the canonical bundles the app ships; origin='custom' is an
-- admin-composed policy. permissions is a JSON array of action patterns ('*' globs ok).
INSERT INTO roles (app, role_key, name, description, permissions, origin, created_at) VALUES
  ('opice',   'editor', 'Editor', 'Read + manage settings',  '["project.read","project.settings.update","report.read"]', 'app',    1782806400),
  ('opice',   'viewer', 'Viewer', 'Read-only access',        '["project.read","report.read"]',                          'app',    1782806400),
  ('poplach', 'editor', 'Editor', 'Read + export reports',   '["project.read","report.read","report.export"]',          'app',    1782806400),
  ('poplach', 'viewer', 'Viewer', 'Read-only access',        '["project.read","report.read"]',                          'app',    1782806400),
  -- One admin-composed custom policy: exporters can read everything and export reports.
  ('opice',   'report-exporter', 'Report Exporter', 'Read all + export reports', '["project.read","report.*"]',        'custom', 1782846400)
  ON CONFLICT DO NOTHING;

-- ── Principals ───────────────────────────────────────────────────────────────
-- `local-dev-admin` is the identity the worker's ENVIRONMENT=local bypass resolves
-- to (see src/auth.ts) — seeding it makes audit/auth-log foreign keys resolve.
INSERT INTO principals (id, type, external_id, email, label, disabled_at, activated_at, created_at) VALUES
  ('local-dev-admin', 'user',    'local-dev-admin', 'admin@local.test', 'local-dev-admin',  NULL,       1782810000, 1782810000),
  ('p-alice',         'user',    'sub-alice',       'alice@firma.cz',   'alice@firma.cz',   NULL,       1782824400, 1782824400),
  ('p-bob-invited',   'user',    NULL,              'bob@firma.cz',     'bob@firma.cz',     NULL,       NULL,       1782892800),
  ('p-carol',         'user',    'sub-carol',       'carol@firma.cz',   'carol@firma.cz',   1782896300, 1782846400, 1782846400),
  ('p-svc-reports',   'service', NULL,              NULL,               'reports-exporter', NULL,       1782836400, 1782836400)
  ON CONFLICT DO NOTHING;

-- ── Grants ───────────────────────────────────────────────────────────────────
-- Scope values (scope_value) are OPAQUE app-owned ids — Propustka never interprets
-- them. Demonstrates the new shapes:
--   * role-based + scoped  — editor on organization=acme in opice
--   * role-based + global  — viewer everywhere in opice (scope NULL)
--   * inline               — ad-hoc permissions JSON, no role_key (note app + scope set)
-- Note `p-bob-invited` gets a grant BEFORE first login (invite/claim flow).
INSERT INTO grants (id, principal_id, app, role_key, permissions, scope_type, scope_value, granted_by, expires_at, created_at) VALUES
  ('grant-alice-org',    'p-alice',       'opice',   'editor', NULL,                                  'organization', 'acme', 'local-dev-admin', NULL, 1782826400),
  ('grant-alice-global', 'p-alice',       'opice',   'viewer', NULL,                                  NULL,           NULL,   'local-dev-admin', NULL, 1782826400),
  ('grant-bob-project',  'p-bob-invited', 'poplach', 'editor', NULL,                                  'project',      'p-42', 'local-dev-admin', NULL, 1782892800),
  -- Inline grant: a one-off permission set with no named role (XOR — role_key NULL).
  ('grant-svc-inline',   'p-svc-reports', 'poplach', NULL,     '["report.read","report.export"]',     'project',      'p-42', 'local-dev-admin', NULL, 1782836400),
  -- Cross-app super-admin: role_key MUST be a BUILT-IN here. A cross-app grant resolves with app=null,
  -- and role lookup at app=null sees the built-ins only (`loadRoleSource`) — so the 'editor' this row
  -- used to name resolved to zero permissions and the seeded "super-admin" could do nothing at all.
  ('grant-admin-all',    'local-dev-admin', NULL,    'admin',  NULL,                                  NULL,           NULL,   'local-dev-admin', NULL, 1782810400)
  ON CONFLICT DO NOTHING;

-- ── Share link = anonymous credential (principal_id NULL; hash only, plaintext never stored). ─
-- expires_at is year-2100 so the seeded link stays usable however old this file gets. `app` is NOT
-- optional on an anonymous credential: its grants are frozen at issue and the app is what stops them
-- being spent anywhere else (migration 0012/0006).
INSERT INTO credentials (id, token_hash, label, principal_id, app, issued_by, expires_at, revoked_at, created_at) VALUES
  ('cred-q2', 'seed-sha256-q2-acme-not-a-real-hash', 'Share: report Q2 (ACME)', NULL, 'opice', 'local-dev-admin', 4102444800, NULL, 1782856400)
  ON CONFLICT DO NOTHING;
-- Frozen inline grants, matched by permits() (action + scope), not an exact resource.
INSERT INTO credential_grants (credential_id, action, scope_type, scope_value) VALUES
  ('cred-q2', 'report.read',            'report', 'q2-acme'),
  ('cred-q2', 'report.feedback.create', 'report', 'q2-acme')
  ON CONFLICT DO NOTHING;

-- ── Domain audit events (TEXT ids chosen to sort by time, newest last) ───────
INSERT INTO audit_events (id, request_id, principal_id, principal_label, credential_id, app, action, resource_type, resource_id, diff, metadata, created_at) VALUES
  ('aud-001', 'req-seed-1', 'local-dev-admin', 'local-dev-admin', NULL, 'iam-admin', 'iam.grant.create',     'grant',     'grant-alice-org',   NULL, '{"role":"editor","scope":"organization=acme"}', 1782826400),
  ('aud-002', 'req-seed-2', 'local-dev-admin', 'local-dev-admin', NULL, 'iam-admin', 'iam.role.create',      'role',      'opice/report-exporter', NULL, '{"origin":"custom"}', 1782846400),
  ('aud-003', 'req-seed-3', 'local-dev-admin', 'local-dev-admin', NULL, 'iam-admin', 'iam.principal.invite', 'principal', 'p-bob-invited',     NULL, '{"email":"bob@firma.cz"}', 1782892800),
  ('aud-004', 'req-seed-4', 'local-dev-admin', 'local-dev-admin', NULL, 'iam-admin', 'iam.credential.create','credential','cred-q2',           NULL, '{"label":"Share: report Q2 (ACME)"}', 1782856400),
  ('aud-005', 'req-seed-5', 'p-alice', 'alice@firma.cz', NULL, 'opice', 'project.settings.update', 'project', 'acme', '{"name":["Acme","Acme (renamed)"]}', NULL, 1782895400)
  ON CONFLICT DO NOTHING;

-- ── Auth log (auto-assigned integer id — omit it) ────────────────────────────
INSERT INTO auth_log (request_id, app, kind, principal_id, credential_id, decision, reason, created_at) VALUES
  ('req-seed-5', 'opice',   'authenticate', 'p-alice', NULL, 'allow', NULL, 1782895400),
  ('req-seed-6', 'opice',   'authenticate', NULL, NULL, 'deny', 'unknown_principal', 1782895500),
  ('req-seed-7', 'poplach', 'authenticate', NULL, 'cred-q2', 'allow', 'mint_key', 1782895600)
  ON CONFLICT DO NOTHING;
