import '@buzola/router'

declare module '@buzola/router' {
	interface BuzolaPageMap {
		'access': {}
		'access/audit/auth-log': {
			principalId?: string
			requestId?: string
			decision?: string
			before?: string
		}
		'access/audit': {
			resourceType?: string
			resourceId?: string
			principalId?: string
			action?: string
			requestId?: string
			before?: string
		}
		'access/credentials': {}
		'access/credentials/keys/new': {}
		'access/credentials/links/new': {}
		'access/permissions': { app?: string }
		'access/permissions/policies/new': { app: string }
		'access/users': {}
		'access/users/detail': { id: string }
		'access/users/grant': { id: string }
		'access/users/new': {}
	}
}
