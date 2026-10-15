// fabrika's OWN authorization vocabulary, declared in code and reconciled into IAM.
//
// Kept in sync with the runtime by importing the SAME constants the control plane enforces against
// (`@fabrika/control-contract`) — the action strings and scope dimensions here are exactly what
// `auth.can(action, scope)` checks.
//
// Roles (`origin='app'`), each a preset for a grant in any scope:
//   - observer → `operations.read`
//   - triager  → `operations.read` + `operations.triage`
//   - deployer → `deploy.*`                   (trigger, read and cancel deploys; no registry, namespace or secret management)
//   - operator → `deploy.*` + `operations.*`
//   - admin    → `*`                          (every action, every scope)
//
// **This module must stay free of `@fabrika/provider-cloudflare`**, like `fabrika.service.ts` next to
// it: a deploy reconciles this schema, and so does `@fabrika/local-stack`, which registers the console
// with IAM because nothing deploys fabrika into the local composition (ADR-0023 — the console's return
// origin has to be registered before a browser can be handed a session on it).

import type { AppSchema } from '@fabrika/auth-core'
import { CONTROL_ACTIONS, CONTROL_SCOPES } from '@fabrika/control-contract'
import { OPERATIONS_ACTIONS } from '@fabrika/operations-contract/access'

export const controlSchema: AppSchema = {
	displayName: 'Console',
	// The two scope dimensions fabrika authorizes within (flat + independent — see `CONTROL_SCOPES`).
	scopes: [
		{ type: CONTROL_SCOPES.APP, label: 'App' },
		{ type: CONTROL_SCOPES.ENVIRONMENT, label: 'Environment' },
	],
	// The concrete actions fabrika enforces — imported from `@fabrika/control-contract` so there is no drift.
	actions: [
		{ action: CONTROL_ACTIONS.DEPLOY_TRIGGER, description: 'Trigger a deploy run' },
		{ action: CONTROL_ACTIONS.DEPLOY_READ, description: 'Read deploy runs + their logs' },
		{ action: CONTROL_ACTIONS.APP_MANAGE, description: 'Manage the app registry (apps + app_envs)' },
		{ action: CONTROL_ACTIONS.NAMESPACE_MANAGE, description: 'Manage deployment namespaces' },
		{ action: CONTROL_ACTIONS.SECRET_MANAGE, description: 'Manage secret values + their references' },
		{ action: CONTROL_ACTIONS.SOURCE_CONNECTION_MANAGE, description: 'Manage the platform GitHub source connection' },
		{ action: CONTROL_ACTIONS.SOURCE_WORKSPACE_READ, description: 'Read own Git workspaces on an authoring target' },
		{ action: CONTROL_ACTIONS.SOURCE_WORKSPACE_WRITE, description: 'Create and commit to own Git workspaces on an authoring target' },
		{ action: CONTROL_ACTIONS.SOURCE_PULL_REQUEST_CREATE, description: 'Open a pull request from an own Git workspace' },
		{ action: CONTROL_ACTIONS.ACCESS_APPROVE, description: 'Approve an access change and protect an environment (a person in the console only)' },
		{ action: OPERATIONS_ACTIONS.READ, description: 'Read Operations errors and activity' },
		{ action: OPERATIONS_ACTIONS.TRIAGE, description: 'Triage Operations errors' },
		{ action: OPERATIONS_ACTIONS.MANAGE, description: 'Manage Operations sources, alerts, and retention' },
	],
	roles: {
		observer: {
			name: 'Observer',
			description: 'Read Operations errors and activity.',
			permissions: [OPERATIONS_ACTIONS.READ],
		},
		triager: {
			name: 'Triager',
			description: 'Read and triage Operations errors.',
			permissions: [OPERATIONS_ACTIONS.READ, OPERATIONS_ACTIONS.TRIAGE],
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
