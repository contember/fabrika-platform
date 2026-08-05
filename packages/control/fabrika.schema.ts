// fabrika's OWN authorization vocabulary, declared in code and reconciled into IAM.
//
// Kept in sync with the runtime by importing the SAME constants the control plane enforces against
// (`src/actions.ts`) — the action strings and scope dimensions here are exactly what
// `auth.can(action, scope)` checks.
//
// Roles (`origin='app'`):
//   - operator → `deploy.*` + `operations.*`  (trigger + read any deploy; no registry/secret management)
//   - admin    → `*`                          (every action, every scope)
//
// **This module must stay free of `@fabrika/provider-cloudflare`**, like `fabrika.gates.ts` next to
// it: a deploy reconciles this schema, and so does `@fabrika/local-stack`, which registers the console
// with IAM because nothing deploys fabrika into the local composition (ADR-0023 — the console's return
// origin has to be registered before a browser can be handed a session on it).

import type { AppSchema } from '@fabrika/auth-core'
import { OPERATIONS_ACTIONS } from '@fabrika/operations-contract/access'
import { ACTIONS, SCOPES } from './src/actions'

export const controlSchema: AppSchema = {
	// The two scope dimensions fabrika authorizes within (flat + independent — see src/actions.ts).
	scopes: [
		{ type: SCOPES.APP, label: 'App' },
		{ type: SCOPES.ENVIRONMENT, label: 'Environment' },
	],
	// The concrete actions fabrika enforces — imported from src/actions.ts so there is no drift.
	actions: [
		{ action: ACTIONS.DEPLOY_TRIGGER, description: 'Trigger a deploy run' },
		{ action: ACTIONS.DEPLOY_READ, description: 'Read deploy runs + their logs' },
		{ action: ACTIONS.APP_MANAGE, description: 'Manage the app registry (apps + app_envs)' },
		{ action: ACTIONS.NAMESPACE_MANAGE, description: 'Manage deployment namespaces' },
		{ action: ACTIONS.SECRET_MANAGE, description: 'Manage secret values + their references' },
		{ action: OPERATIONS_ACTIONS.READ, description: 'Read Operations errors and activity' },
		{ action: OPERATIONS_ACTIONS.TRIAGE, description: 'Triage Operations errors' },
		{ action: OPERATIONS_ACTIONS.MANAGE, description: 'Manage Operations sources, alerts, and retention' },
	],
	roles: {
		operator: {
			name: 'Operator',
			description: 'Trigger and read any deploy (no registry or secret management).',
			// `deploy.*` covers deploy.trigger + deploy.read (prefix wildcard).
			permissions: ['deploy.*', 'operations.*'],
		},
		admin: {
			name: 'Admin',
			description: 'Full access to every vozka action in every scope.',
			permissions: ['*'],
		},
	},
}
