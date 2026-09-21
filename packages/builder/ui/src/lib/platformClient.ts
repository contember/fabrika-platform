import {
	type BuilderPlatformStatus,
	builderProjectPath,
	parseBuilderOrigin,
	parseBuilderPlatformStatus,
	parseBuilderPreviewUrl,
} from '../../../shared'

export class PlatformClientError extends Error {}

export type PlatformAction = { kind: 'connect'; controlOrigin: string } | { kind: 'preview'; url: string | null } | { kind: 'deploy' | 'disconnect' }

export function createPlatformClient(request: typeof fetch = fetch) {
	async function call(
		id: string,
		suffix: Parameters<typeof builderProjectPath>[1],
		body?: object,
		signal?: AbortSignal,
	): Promise<BuilderPlatformStatus> {
		let response: Response
		try {
			response = await request(builderProjectPath(id, suffix), {
				method: body ? 'POST' : 'GET',
				headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
				...(body ? { body: JSON.stringify(body) } : {}),
				redirect: 'error',
				cache: 'no-store',
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
			})
		} catch {
			throw new PlatformClientError('Local builder unavailable. Check the daemon and refresh status.')
		}
		let value: unknown
		try {
			value = await response.json()
		} catch {
			throw new PlatformClientError('Local builder returned an invalid response. Refresh status before continuing.')
		}
		if (!response.ok) {
			if (typeof value === 'object' && value !== null && 'error' in value) {
				const error = value.error
				if (
					typeof error === 'object' && error !== null && 'code' in error && error.code === 'builder_platform'
					&& 'message' in error && typeof error.message === 'string' && error.message.length <= 1000
				) {
					throw new PlatformClientError(error.message)
				}
			}
			throw new PlatformClientError('Local builder rejected the request. Refresh status before continuing.')
		}
		try {
			const status = parseBuilderPlatformStatus(value)
			if (status.sessionId !== id) throw new Error('Session mismatch')
			return status
		} catch {
			throw new PlatformClientError('Local builder returned an invalid status. Refresh status before continuing.')
		}
	}
	return {
		status: (id: string, signal?: AbortSignal) => call(id, 'platform', undefined, signal),
		register: (id: string, projectRoot: string) => call(id, 'register', { projectRoot }),
		act: (id: string, action: PlatformAction, signal?: AbortSignal) => {
			let body: object = {}
			try {
				if (action.kind === 'connect') body = { controlOrigin: parseBuilderOrigin(action.controlOrigin) }
				if (action.kind === 'preview') body = { url: action.url === null ? null : parseBuilderPreviewUrl(action.url) }
			} catch {
				throw new PlatformClientError('Enter a valid URL without credentials. Control origins require HTTPS except on localhost.')
			}
			return call(id, action.kind, body, signal)
		},
	}
}

export const platformClient = createPlatformClient()
