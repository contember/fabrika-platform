import '@buzola/router'

declare module '@buzola/router' {
	interface BuzolaPageMap {
		'operations': {}
		'operations/errors': {}
		'operations/errors/detail': { issueId: string }
		'operations/health': {}
		'operations/releases': {}
		'operations/sources': {}
		'operations/sources/alerts': { sourceId: string }
		'operations/sources/detail': { sourceId: string }
	}
}
