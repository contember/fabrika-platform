import '@buzola/router'

declare module '@buzola/router' {
	interface BuzolaPageMap {
		'access/api-keys': {}
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
		'access/principals/detail': { id: string }
		'access/principals': {}
		'access/roles': { app?: string }
		'access/schema': { app?: string }
		'access/share-links': {}
	}
}
