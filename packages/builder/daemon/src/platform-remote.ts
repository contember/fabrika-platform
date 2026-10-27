import { createRpcClient, type RpcFetch } from '@fabrika/app'
import {
	APP_ENV_KINDS,
	type AppEnvDto,
	type ControlRpcContract,
	type JsonValue,
	type ProviderEnvelopeDto,
	type RunStatus,
	SURFACE_REACHES,
	type SurfaceEndpointDto,
} from '@fabrika/control-contract'
import { z } from 'zod'
import { parseBuilderOrigin } from '../../shared'
import { PlatformError, type StoredCredential, storedIntegerSchema, storedTextSchema } from './platform-storage'

const discoveryInputSchema = z.object({ version: z.literal(1), controlOrigin: z.unknown(), iamIssuer: z.unknown(), provider: z.unknown() })
	.strict().refine(value => Object.keys(value).length === 4)
const rpcResultSchema = z.object({ result: z.unknown() }).passthrough().refine(value =>
	Object.hasOwn(value, 'result') && !Object.hasOwn(value, 'error')
)
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.null(),
		z.string(),
		z.boolean(),
		z.number().finite(),
		z.array(jsonValueSchema),
		z.record(jsonValueSchema),
	])
)
const envelopeSchema: z.ZodType<ProviderEnvelopeDto> = z.object({
	provider: storedTextSchema,
	version: storedIntegerSchema,
	payload: jsonValueSchema,
})
const surfaceEndpointSchema: z.ZodType<SurfaceEndpointDto> = z.object({
	id: storedTextSchema,
	method: z.enum(['GET', 'POST']),
	path: storedTextSchema,
	kind: z.enum(['query', 'mutation', 'spa', 'upload', 'download', 'health', 'form', 'webhook', 'link-spa', 'public-spa']),
	reach: z.enum(SURFACE_REACHES),
	callers: z.array(storedTextSchema),
	requirement: storedTextSchema.nullable(),
	notes: z.array(storedTextSchema),
})
const environmentsSchema = z.object({
	items: z.array(z.object({
		appId: storedTextSchema,
		env: storedTextSchema,
		// A Control older than the field has standard environments only.
		kind: z.enum(APP_ENV_KINDS).default('standard'),
		domain: storedTextSchema.nullable(),
		publicOrigin: storedTextSchema.nullable(),
		// A Control older than the field lists none.
		crossOrigins: z.array(storedTextSchema).default([]),
		triggerRef: storedTextSchema.nullable(),
		authoring: z.boolean(),
		protected: z.boolean(),
		publishedRunId: storedTextSchema.nullable(),
		// A Control older than the field lists none.
		deviationSubjects: z.array(z.object({ subject: storedTextSchema, steps: z.array(storedTextSchema) })).default([]),
		// A Control older than the field lists none.
		surface: z.array(surfaceEndpointSchema).default([]),
		namespaceId: storedTextSchema.nullable(),
		provider: storedTextSchema,
		target: envelopeSchema,
		artifact: envelopeSchema,
		createdAt: storedIntegerSchema,
	})),
})
const runSchema = z.object({
	id: storedTextSchema,
	appId: storedTextSchema,
	env: storedTextSchema,
	ref: storedTextSchema,
	commitSha: storedTextSchema.nullable(),
	status: z.enum(['pending', 'running', 'awaiting_approval', 'succeeded', 'failed']),
})

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
	constructor(private readonly fetcher: RpcFetch = (input, init) => fetch(input, init), readonly signal: AbortSignal) {}

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
		const result = discoveryInputSchema.safeParse(await this.json(`${origin}/.well-known/fabrika-builder`))
		if (!result.success) throw new PlatformError('Unsupported builder discovery response')
		const discovery = result.data
		const controlOrigin = parseBuilderOrigin(discovery.controlOrigin, 'Control origin')
		const iamIssuer = parseBuilderOrigin(discovery.iamIssuer, 'IAM issuer')
		if (controlOrigin !== origin) throw new PlatformError('Discovery Control origin does not match the requested installation')
		if (discovery.provider !== 'zerops') throw new PlatformError('Unsupported provider: this builder release supports Zerops only')
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
				const data = rpcResultSchema.safeParse(await boundedJson(response))
				if (!data.success) throw new PlatformError('Control refused the request')
				return Response.json({ result: data.data.result })
			},
		})
	}
}

export function parseEnvironments(value: unknown): AppEnvDto[] {
	const result = environmentsSchema.safeParse(value)
	if (!result.success) {
		const invalidList = result.error.issues.some(issue => issue.path.length === 1 && issue.path[0] === 'items')
		throw new PlatformError(invalidList ? 'Invalid environment list' : 'Invalid stored or upstream data')
	}
	return result.data.items
}

export function parseRun(value: unknown): { id: string; appId: string; env: string; ref: string; commitSha: string | null; status: RunStatus } {
	const result = runSchema.safeParse(value)
	if (!result.success) {
		const invalidStatus = result.error.issues.some(issue => issue.path[0] === 'status')
		throw new PlatformError(invalidStatus ? 'Invalid deploy run status' : 'Invalid stored or upstream data')
	}
	return result.data
}
