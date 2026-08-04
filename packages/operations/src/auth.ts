import { createIam, type Iam, type IamEnv, type PersonaSpec } from '@fabrika/auth'

export const OPERATIONS_AUTH_APP_ID = 'vozka'
export const OPERATIONS_DEV_PERSONA_COOKIE = 'vozka_dev_principal'

const DEV_PERSONAS: Record<string, PersonaSpec> = {
	'admin@vozka.test': {
		id: 'mem-admin',
		label: 'admin@vozka.test',
		type: 'user',
		permissions: [{ action: '*', scope: null }],
	},
	'operator@vozka.test': {
		id: 'mem-operator',
		label: 'operator@vozka.test',
		type: 'user',
		permissions: [{ action: 'operations.*', scope: null }],
	},
	'viewer@vozka.test': {
		id: 'mem-viewer',
		label: 'viewer@vozka.test',
		type: 'user',
		permissions: [{ action: 'operations.read', scope: null }],
	},
}

/** Operations authenticates as the same Fabrika IAM application as the control console. */
export function createOperationsIam(env: IamEnv): Iam {
	return createIam(env, {
		appId: OPERATIONS_AUTH_APP_ID,
		devPersonas: DEV_PERSONAS,
		devDefaultPersona: 'admin@vozka.test',
		devPersonaCookie: OPERATIONS_DEV_PERSONA_COOKIE,
	})
}
