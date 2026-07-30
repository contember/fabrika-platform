export type PoplachClassification =
	| 'domain'
	| 'browser-contract'
	| 'ui'
	| 'cloudflare-adapter'
	| 'fixture'
	| 'standalone-deployment'

export type PoplachDisposition = 'migrated' | 'replaced' | 'deferred'

export interface PoplachInventoryEntry {
	path: string
	classification: PoplachClassification
	disposition: PoplachDisposition
	target: string
}

export const POPLACH_SOURCE_COMMIT = '8e0c79d662c187fe41eacd0fee9fe77fde668f1f'

export const POPLACH_SOURCE_INVENTORY: readonly PoplachInventoryEntry[] = [
	{ path: 'src/api/ingest.ts', classification: 'cloudflare-adapter', disposition: 'replaced', target: 'operations/src/direct-ingest.ts' },
	{ path: 'src/context.ts', classification: 'cloudflare-adapter', disposition: 'deferred', target: 'WU3 operator authorization composition' },
	{ path: 'src/cron.ts', classification: 'cloudflare-adapter', disposition: 'replaced', target: 'operations Cloudflare scheduled seam' },
	{
		path: 'src/lib/activity.ts',
		classification: 'domain',
		disposition: 'replaced',
		target: 'operations-contract ActivityKind and operations issue decisions',
	},
	{ path: 'src/lib/alerts.ts', classification: 'domain', disposition: 'replaced', target: 'operations alert decision and notification maintenance' },
	{ path: 'src/lib/cf-analytics.ts', classification: 'cloudflare-adapter', disposition: 'deferred', target: 'WU2 signal-store adapters' },
	{
		path: 'src/lib/consume.ts',
		classification: 'cloudflare-adapter',
		disposition: 'replaced',
		target: 'operations pipeline and SQL ingest repository',
	},
	{ path: 'src/lib/count-store.ts', classification: 'cloudflare-adapter', disposition: 'replaced', target: 'operations exact SQL occurrence queries' },
	{ path: 'src/lib/format.ts', classification: 'ui', disposition: 'migrated', target: 'operations-ui/src/format.ts' },
	{ path: 'src/lib/http.ts', classification: 'cloudflare-adapter', disposition: 'replaced', target: 'direct ingest Response helpers' },
	{ path: 'src/lib/ingest-metrics.ts', classification: 'cloudflare-adapter', disposition: 'deferred', target: 'WU2 signal-store port and adapters' },
	{ path: 'src/lib/ingest.ts', classification: 'domain', disposition: 'migrated', target: 'operations/src/ingest.ts' },
	{ path: 'src/lib/sourcemaps.ts', classification: 'domain', disposition: 'migrated', target: 'operations/src/source-maps.ts' },
	{ path: 'src/lib/system-status.ts', classification: 'domain', disposition: 'deferred', target: 'WU6 portable health model' },
	{ path: 'src/queue.ts', classification: 'cloudflare-adapter', disposition: 'replaced', target: 'operations portable consumer and Bun consumer' },
	{ path: 'src/rpc/errors.ts', classification: 'browser-contract', disposition: 'deferred', target: 'WU3/WU7 operator REST errors' },
	{
		path: 'src/rpc/gates.ts',
		classification: 'browser-contract',
		disposition: 'replaced',
		target: 'operations direct/operator package separation; policy projection in WU3',
	},
	{ path: 'src/rpc/init.ts', classification: 'cloudflare-adapter', disposition: 'deferred', target: 'WU3 operator API composition' },
	{ path: 'src/rpc/messages.ts', classification: 'ui', disposition: 'deferred', target: 'WU7 console copy' },
	{
		path: 'src/rpc/procedures/alerts.ts',
		classification: 'browser-contract',
		disposition: 'deferred',
		target: 'WU2 alert repositories and WU7 routes',
	},
	{ path: 'src/rpc/procedures/auth.ts', classification: 'browser-contract', disposition: 'deferred', target: 'WU3 Access-owned operator identity' },
	{
		path: 'src/rpc/procedures/issues.ts',
		classification: 'browser-contract',
		disposition: 'replaced',
		target: 'operations-contract DTOs plus event-detail and issue decision kernels',
	},
	{ path: 'src/rpc/procedures/people.ts', classification: 'browser-contract', disposition: 'deferred', target: 'WU3 Access principal projection' },
	{ path: 'src/rpc/procedures/projects.ts', classification: 'browser-contract', disposition: 'deferred', target: 'WU3 Delivery catalog projection' },
	{ path: 'src/rpc/procedures/system.ts', classification: 'browser-contract', disposition: 'deferred', target: 'WU6 health contract' },
	{ path: 'src/rpc/router.ts', classification: 'cloudflare-adapter', disposition: 'deferred', target: 'WU3/WU7 operator API gateway' },
	{ path: 'src/spa/buzola.gen.ts', classification: 'ui', disposition: 'deferred', target: 'WU7 dashboard route generation' },
	{ path: 'src/spa/client.ts', classification: 'ui', disposition: 'replaced', target: 'operations-contract browser-safe DTO boundary' },
	{
		path: 'src/spa/index.html',
		classification: 'standalone-deployment',
		disposition: 'deferred',
		target: 'WU7 unified console; standalone shell retires in WU9',
	},
	{ path: 'src/spa/main.tsx', classification: 'standalone-deployment', disposition: 'deferred', target: 'WU7 unified console composition' },
	{ path: 'src/spa/routes/_404.tsx', classification: 'ui', disposition: 'deferred', target: 'WU7 dashboard not-found route' },
	{ path: 'src/spa/routes/_layout.tsx', classification: 'ui', disposition: 'deferred', target: 'WU7 unified console layout' },
	{ path: 'src/spa/routes/login.tsx', classification: 'ui', disposition: 'deferred', target: 'WU7 Access-owned login flow' },
	{ path: 'src/spa/routes/shell/_layout.tsx', classification: 'ui', disposition: 'deferred', target: 'WU7 Operations plane layout' },
	{ path: 'src/spa/routes/shell/index.tsx', classification: 'ui', disposition: 'deferred', target: 'WU7 issue list route' },
	{ path: 'src/spa/routes/shell/issue.tsx', classification: 'ui', disposition: 'deferred', target: 'WU7 issue detail route' },
	{ path: 'src/spa/routes/shell/projects/alerts.tsx', classification: 'ui', disposition: 'deferred', target: 'WU7 alert settings route' },
	{ path: 'src/spa/routes/shell/projects/detail.tsx', classification: 'ui', disposition: 'deferred', target: 'WU7 project detail route' },
	{ path: 'src/spa/routes/shell/projects/index.tsx', classification: 'ui', disposition: 'deferred', target: 'WU7 source list route' },
	{ path: 'src/spa/routes/shell/status.tsx', classification: 'ui', disposition: 'deferred', target: 'WU6/WU7 health route' },
	{ path: 'src/spa/strings.ts', classification: 'ui', disposition: 'deferred', target: 'WU7 console copy' },
	{ path: 'src/spa/styles.css', classification: 'ui', disposition: 'deferred', target: 'WU7 dashboard design-system integration' },
	{ path: 'src/worker.ts', classification: 'standalone-deployment', disposition: 'deferred', target: 'WU8 runtime composition roots' },
	{
		path: 'migrations/0001_init.sql',
		classification: 'cloudflare-adapter',
		disposition: 'replaced',
		target: 'operations final SQLite and Postgres schemas',
	},
	{
		path: 'migrations/0002_sent_alerts.sql',
		classification: 'cloudflare-adapter',
		disposition: 'replaced',
		target: 'operations notification outbox schema',
	},
	{
		path: 'migrations/0003_event_counts_eventid.sql',
		classification: 'cloudflare-adapter',
		disposition: 'replaced',
		target: 'operations exact idempotent occurrence schema',
	},
	{
		path: 'migrations/0004_issue_activity.sql',
		classification: 'cloudflare-adapter',
		disposition: 'replaced',
		target: 'operations final issue activity schema',
	},
	{
		path: 'migrations/0005_issue_regressed.sql',
		classification: 'cloudflare-adapter',
		disposition: 'replaced',
		target: 'operations final issues schema',
	},
	{
		path: 'migrations/0006_issue_snooze.sql',
		classification: 'cloudflare-adapter',
		disposition: 'replaced',
		target: 'operations final issues schema',
	},
	{ path: 'migrations/0007_issue_merge.sql', classification: 'cloudflare-adapter', disposition: 'replaced', target: 'operations final issues schema' },
	{ path: 'migrations/0008_alert_rules.sql', classification: 'cloudflare-adapter', disposition: 'replaced', target: 'operations final alert schema' },
	{
		path: 'migrations/0009_notification_channels.sql',
		classification: 'cloudflare-adapter',
		disposition: 'replaced',
		target: 'operations final notification schema',
	},
	{
		path: 'migrations/0010_drop_member_password_hash.sql',
		classification: 'standalone-deployment',
		disposition: 'replaced',
		target: 'Access owns identities; no Operations migration',
	},
	{
		path: 'migrations/0011_drop_members_directory.sql',
		classification: 'standalone-deployment',
		disposition: 'replaced',
		target: 'Access owns identities; no Operations migration',
	},
	{ path: 'seeds/_lib.ts', classification: 'fixture', disposition: 'replaced', target: 'operations SQLite repository harness' },
	{
		path: 'seeds/alert-config.sql',
		classification: 'fixture',
		disposition: 'replaced',
		target: 'operations alert decision and repository tests',
	},
	{
		path: 'seeds/issues-mixed.sql',
		classification: 'fixture',
		disposition: 'replaced',
		target: 'operations SQLite and Postgres repository contracts',
	},
	{ path: 'seeds/issues-mixed.ts', classification: 'fixture', disposition: 'migrated', target: 'operations event-detail tests' },
	{ path: 'seeds/project.sql', classification: 'fixture', disposition: 'deferred', target: 'WU2/WU3 projected source fixture' },
	{ path: 'seeds/project.ts', classification: 'fixture', disposition: 'replaced', target: 'operations testing envelope and ingest-key fixtures' },
	{ path: 'seeds/release-sourcemap.sql', classification: 'fixture', disposition: 'replaced', target: 'operations release repository tests' },
	{ path: 'seeds/release-sourcemap.ts', classification: 'fixture', disposition: 'migrated', target: 'operations source-map tests' },
	{
		path: 'tests/browser/_helpers.ts',
		classification: 'fixture',
		disposition: 'replaced',
		target: 'operations/src/testing.ts; runtime helpers deferred to WU9',
	},
	{ path: 'tests/browser/_smoke.test.ts', classification: 'browser-contract', disposition: 'deferred', target: 'WU9 local-stack browser witness' },
	{
		path: 'tests/browser/alerts-disabled.test.ts',
		classification: 'browser-contract',
		disposition: 'deferred',
		target: 'WU7/WU9 alert settings witness',
	},
	{
		path: 'tests/browser/dsn-roundtrip.test.ts',
		classification: 'browser-contract',
		disposition: 'deferred',
		target: 'WU4/WU9 managed ingest witness',
	},
	{
		path: 'tests/browser/email-channel.test.ts',
		classification: 'browser-contract',
		disposition: 'deferred',
		target: 'WU6/WU9 email transport decision and browser witness',
	},
	{
		path: 'tests/browser/ingest-and-group.test.ts',
		classification: 'browser-contract',
		disposition: 'replaced',
		target: 'operations ingest and issue lifecycle tests; end-to-end witness in WU9',
	},
	{
		path: 'tests/browser/ingest-validation.test.ts',
		classification: 'browser-contract',
		disposition: 'replaced',
		target: 'operations ingest tests; HTTP limits and auth in WU4',
	},
	{
		path: 'tests/browser/issue-ignore.test.ts',
		classification: 'browser-contract',
		disposition: 'replaced',
		target: 'operations issue lifecycle tests; UI witness in WU7',
	},
	{
		path: 'tests/browser/issue-tracking-extras.test.ts',
		classification: 'browser-contract',
		disposition: 'replaced',
		target: 'operations fingerprint and mutation tests; UI witness in WU7',
	},
	{
		path: 'tests/browser/member-access.test.ts',
		classification: 'browser-contract',
		disposition: 'deferred',
		target: 'WU3/WU9 Access policy witness',
	},
	{ path: 'tests/browser/not-found.test.ts', classification: 'browser-contract', disposition: 'deferred', target: 'WU7 operator API and UI witness' },
	{
		path: 'tests/browser/project-setup.test.ts',
		classification: 'browser-contract',
		disposition: 'deferred',
		target: 'WU3/WU4 source provisioning witness',
	},
	{
		path: 'tests/browser/resource-routes.test.ts',
		classification: 'browser-contract',
		disposition: 'deferred',
		target: 'WU4/WU5 HTTP method and parameter witness',
	},
	{ path: 'tests/browser/sign-in.test.ts', classification: 'browser-contract', disposition: 'deferred', target: 'WU3/WU7 Access login witness' },
	{
		path: 'tests/browser/source-maps.test.ts',
		classification: 'browser-contract',
		disposition: 'replaced',
		target: 'operations source-map tests; upload witness in WU5',
	},
	{
		path: 'tests/browser/spike-alert.test.ts',
		classification: 'browser-contract',
		disposition: 'replaced',
		target: 'operations alert decision tests; delivery witness in WU2',
	},
	{
		path: 'tests/browser/triage-issues.test.ts',
		classification: 'browser-contract',
		disposition: 'replaced',
		target: 'operations event-detail and issue mutation tests; UI witness in WU7',
	},
]
