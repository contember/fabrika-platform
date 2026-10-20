// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Source: packages/platform-artifacts/src/console-schema.ts
// Regenerate: bun run --filter @fabrika/platform-artifacts gen
//
// The console's authorization vocabulary — `controlSchema` in `@fabrika/control` — as DATA. A
// PUBLISHED deploy command may not import the private package that declares it, and `platform deploy`
// has to send this document to IAM: the schema PUT is what REGISTERS the app, and
// `apps.setReturnOrigins` 404s for an app IAM has never heard of. `gen:check` is the drift witness.

import type { AppSchema } from '@fabrika/auth-core'

export const PLATFORM_CONSOLE_APP_SCHEMA: AppSchema = {
	displayName: 'Console',
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
		{ action: 'source.workspace.read', description: 'Read own Git workspaces on an authoring target' },
		{ action: 'source.workspace.write', description: 'Create and commit to own Git workspaces on an authoring target' },
		{ action: 'source.pull-request.create', description: 'Open a pull request from an own Git workspace' },
		{ action: 'access.approve', description: 'Approve an access change and protect an environment (a person in the console only)' },
		{ action: 'mail.read', description: 'List relayed mail and read its metadata' },
		{ action: 'mail.content.read', description: 'Read the recipient, subject and bodies of relayed mail' },
		{ action: 'mail.manage', description: 'Release or drop held mail and manage the mail rules' },
		{ action: 'operations.read', description: 'Read Operations errors and activity' },
		{ action: 'operations.triage', description: 'Triage Operations errors' },
		{ action: 'operations.manage', description: 'Manage Operations sources, alerts, and retention' },
	],
	roles: {
		observer: {
			name: 'Observer',
			description: 'Read Operations errors and activity.',
			permissions: ['operations.read'],
		},
		triager: {
			name: 'Triager',
			description: 'Read and triage Operations errors.',
			permissions: ['operations.read', 'operations.triage'],
		},
		deployer: {
			name: 'Deployer',
			description: 'Trigger, read and cancel deploys (no registry, namespace or secret management).',
			permissions: ['deploy.*'],
		},
		operator: {
			name: 'Operator',
			description: 'Deploy, and read, triage and manage Operations (no registry or secret management).',
			permissions: ['deploy.*', 'operations.*'],
		},
		admin: {
			name: 'Admin',
			description: 'Every console action in every scope.',
			permissions: ['*'],
		},
	},
}
