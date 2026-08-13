// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Source: packages/installation-zerops/zerops/console-schema.ts
// Regenerate: bun run --filter @fabrika/installation-zerops gen
//
// The console's authorization vocabulary — `controlSchema` in `@fabrika/control` — as DATA. A
// PUBLISHED deploy command may not import the private package that declares it, and `platform deploy`
// has to send this document to IAM: the schema PUT is what REGISTERS the app, and
// `apps.setReturnOrigins` 404s for an app IAM has never heard of. `gen:check` is the drift witness.

import type { AppSchema } from '@fabrika/auth-core'

export const PLATFORM_CONSOLE_APP_SCHEMA: AppSchema = {
	scopes: [
		{ type: 'app', label: 'App' },
		{ type: 'environment', label: 'Environment' },
	],
	actions: [
		{ action: 'deploy.trigger', description: 'Trigger a deploy run' },
		{ action: 'deploy.read', description: 'Read deploy runs + their logs' },
		{ action: 'app.manage', description: 'Manage the app registry (apps + app_envs)' },
		{ action: 'namespace.manage', description: 'Manage deployment namespaces' },
		{ action: 'secret.manage', description: 'Manage secret values + their references' },
		{ action: 'source.connection.manage', description: 'Manage the platform GitHub source connection' },
		{ action: 'operations.read', description: 'Read Operations errors and activity' },
		{ action: 'operations.triage', description: 'Triage Operations errors' },
		{ action: 'operations.manage', description: 'Manage Operations sources, alerts, and retention' },
	],
	roles: {
		operator: {
			name: 'Operator',
			description: 'Trigger and read any deploy (no registry or secret management).',
			permissions: ['deploy.*', 'operations.*'],
		},
		admin: {
			name: 'Admin',
			description: 'Full access to every vozka action in every scope.',
			permissions: ['*'],
		},
	},
}
