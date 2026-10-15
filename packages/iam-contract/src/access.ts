// IAM's own vocabulary (ADR-0058): what IAM authorizes its administration against, reconciled under its durable app id
// beside the console's by every installation path.

import type { AppSchema } from '@fabrika/auth-core'

/** Durable IAM application id of IAM itself — a deployed identity, not configuration branding (ADR-0024). */
export const IAM_APP_ID = 'propustka'

export const IAM_ACTIONS = Object.freeze({
	/** Administer identity and access for the installation. Global only; it reaches every application. */
	ADMIN: 'iam.admin',
	/** Manage the people of applications, never of the installation's own apps. Global, or in `app` values. */
	USERS_MANAGE: 'iam.users.manage',
})

export const IAM_SCOPES = Object.freeze({
	/** One application environment, by its IAM id `<app>@<env>`. */
	APP: 'app',
})

/** The preset role a user administrator holds. */
export const USER_ADMIN_ROLE = 'user-admin'

export const IAM_APP_SCHEMA: AppSchema = {
	displayName: 'Access',
	scopes: [{ type: IAM_SCOPES.APP, label: 'Application' }],
	actions: [
		{ action: IAM_ACTIONS.ADMIN, description: 'Administer identity and access for the installation' },
		{ action: IAM_ACTIONS.USERS_MANAGE, description: 'Manage the people of applications: invite, sign out, reset, grant and revoke' },
	],
	roles: {
		[USER_ADMIN_ROLE]: {
			name: 'User administrator',
			description: "Manage the people of the applications in scope; nothing of the installation's own apps.",
			permissions: [IAM_ACTIONS.USERS_MANAGE],
		},
	},
}
