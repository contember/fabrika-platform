import { createRpcClient, type RpcFetch } from '@fabrika/app'
import type { AppEnvDto, ControlRpcContract, JsonValue, ProviderEnvelopeDto, RunStatus } from '@fabrika/control-contract'
import { parseBuilderOrigin } from '../../shared'
import { integer, PlatformError, record, type StoredCredential, text } from './platform-storage'

export async function boundedJson(response: Response): Promise<unknown> {
	if (!response.ok) {
		await response.body?.cancel()
		throw new PlatformError(`Platform request failed (HTTP ${response.status})`)
	}
	const reader = response.body?.getReader()
	if (!reader) throw new PlatformError('Platform response is empty')
	let size = 0
	const chunks: Uint8Array[] = []
	try {
		while (true) {
			const part = await reader.read()
			if (part.done) break
			size += part.value.byteLength
			if (size > 1024 * 1024) throw new PlatformError('Platform response exceeds size limit')
			chunks.push(part.value)
		}
		return JSON.parse(Buffer.concat(chunks).toString('utf8'))
	} finally {
		await reader.cancel()
	}
}

export class PlatformRemote {
	constructor(private readonly fetcher: RpcFetch = fetch, readonly signal: AbortSignal) {}

	async json(url: string, body?: unknown): Promise<unknown> {
		try {
			return await boundedJson(
				await this.fetcher(url, {
					method: body === undefined ? 'GET' : 'POST',
					...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
					redirect: 'error',
					credentials: 'omit',
					signal: AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]),
				}),
			)
		} catch (error) {
			throw error instanceof PlatformError ? error : new PlatformError('Platform request failed or returned invalid data')
		}
	}

	async discover(origin: string): Promise<{ controlOrigin: string; iamIssuer: string }> {
		const discovery = record(await this.json(`${origin}/.well-known/fabrika-builder`))
		if (Object.keys(discovery).sort().join(',') !== 'controlOrigin,iamIssuer,provider,version' || discovery['version'] !== 1) {
			throw new PlatformError('Unsupported builder discovery response')
		}
		const controlOrigin = parseBuilderOrigin(discovery['controlOrigin'], 'Control origin')
		const iamIssuer = parseBuilderOrigin(discovery['iamIssuer'], 'IAM issuer')
		if (controlOrigin !== origin) throw new PlatformError('Discovery Control origin does not match the requested installation')
		if (discovery['provider'] !== 'zerops') throw new PlatformError('Unsupported provider: this builder release supports Zerops only')
		return { controlOrigin, iamIssuer }
	}

	control(credential: StoredCredential) {
		return this.controlForReceipt(credential.connection.controlOrigin, credential.token)
	}

	controlForReceipt(controlOrigin: string, token: string) {
		const endpoint = `${controlOrigin}/api/rpc`
		return createRpcClient<ControlRpcContract>({
			baseUrl: endpoint,
			fetch: async (input, init) => {
				if (input !== endpoint) throw new PlatformError('Control endpoint mismatch')
				const headers = new Headers(init?.headers)
				headers.set('authorization', `Bearer ${token}`)
				const response = await this.fetcher(input, {
					...init,
					headers,
					credentials: 'omit',
					redirect: 'error',
					signal: AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]),
				})
				const data = record(await boundedJson(response))
				if (Object.hasOwn(data, 'error') || !Object.hasOwn(data, 'result')) throw new PlatformError('Control refused the request')
				return Response.json({ result: data['result'] })
			},
		})
	}
}

function jsonValue(value: unknown): JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (Array.isArray(value)) return value.map(jsonValue)
	return Object.fromEntries(Object.entries(record(value)).map(([key, item]) => [key, jsonValue(item)]))
}

function nullableText(value: unknown): string | null {
	return value === null ? null : text(value)
}

function envelope(value: unknown): ProviderEnvelopeDto {
	const input = record(value)
	return { provider: text(input['provider']), version: integer(input['version']), payload: jsonValue(input['payload']) }
}

export function parseEnvironments(value: unknown): AppEnvDto[] {
	const items = record(value)['items']
	if (!Array.isArray(items)) throw new PlatformError('Invalid environment list')
	return items.map((item: unknown) => {
		const input = record(item)
		return {
			appId: text(input['appId']),
			env: text(input['env']),
			domain: nullableText(input['domain']),
			publicOrigin: nullableText(input['publicOrigin']),
			triggerRef: nullableText(input['triggerRef']),
			namespaceId: nullableText(input['namespaceId']),
			provider: text(input['provider']),
			target: envelope(input['target']),
			artifact: envelope(input['artifact']),
			createdAt: integer(input['createdAt']),
		}
	})
}

export function parseRun(value: unknown): { id: string; appId: string; env: string; ref: string; commitSha: string | null; status: RunStatus } {
	const run = record(value)
	const status = run['status']
	if (status !== 'pending' && status !== 'running' && status !== 'succeeded' && status !== 'failed') {
		throw new PlatformError('Invalid deploy run status')
	}
	return {
		id: text(run['id']),
		appId: text(run['appId']),
		env: text(run['env']),
		ref: text(run['ref']),
		commitSha: nullableText(run['commitSha']),
		status,
	}
}
