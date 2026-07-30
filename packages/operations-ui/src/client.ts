// Same-origin transport for the future operator API. Domain methods belong here only after their
// response DTOs are part of operations-contract.

export class OperationsApiError extends Error {
	readonly status: number

	constructor(status: number, message: string) {
		super(message)
		this.name = 'OperationsApiError'
		this.status = status
	}
}

const BASE = '/operations/api'

export function operationsApiUrl(path: string): string {
	if (!path.startsWith('/') || path.startsWith('//')) {
		throw new Error('Operations API paths must be same-origin absolute paths')
	}
	return `${BASE}${path}`
}

async function readError(response: Response): Promise<OperationsApiError> {
	let message = `Request failed (${response.status})`
	try {
		const contentType = response.headers.get('content-type') ?? ''
		if (contentType.includes('application/json')) {
			const body: unknown = await response.json()
			if (body !== null && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
				message = body.message
			} else if (body !== null && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
				message = body.error
			}
		} else {
			const text = await response.text()
			if (text.trim().length > 0 && text.length < 500) message = text
		}
	} catch {
		// Keep the status-based message when an error body is unreadable.
	}
	return new OperationsApiError(response.status, message)
}

export interface OperationsClient {
	request<T>(method: string, path: string, body?: unknown): Promise<T>
}

export type OperationsFetch = (input: string, init: RequestInit) => Promise<Response>

export function createOperationsClient(fetcher: OperationsFetch = (input, init) => fetch(input, init)): OperationsClient {
	return {
		async request<T>(method: string, path: string, body?: unknown): Promise<T> {
			const headers: Record<string, string> = { accept: 'application/json' }
			if (body !== undefined) headers['content-type'] = 'application/json'

			let response: Response
			try {
				response = await fetcher(operationsApiUrl(path), {
					method,
					headers,
					credentials: 'include',
					redirect: 'manual',
					body: body === undefined ? undefined : JSON.stringify(body),
				})
			} catch (cause) {
				const message = cause instanceof Error ? cause.message : 'Network request failed'
				throw new OperationsApiError(0, message)
			}

			if (!response.ok) throw await readError(response)
			const text = await response.text()
			return JSON.parse(text.trim() === '' ? 'null' : text)
		},
	}
}

export const operationsClient = createOperationsClient()
