import '@buzola/router'

declare module '@buzola/router' {
	interface BuzolaPageMap {
		'access/api-keys': {}
		'access/api-keys/new': {}
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
		'access/policies': { app?: string }
		'access/policies/new': { app: string }
		'access/principals/detail': { id: string }
		'access/principals/grant': { id: string }
		'access/principals': {}
		'access/principals/new': {}
		'access/roles': { app?: string }
		'access/schema': { app?: string }
		'access/share-links': {}
		'access/share-links/new': {}
	}
}
