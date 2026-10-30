import { z } from 'zod'

// Each schema reads only the fields the provider uses; Box adds fields freely and they are ignored.

const nullableString = z
	.string()
	.nullish()
	.transform((value) => value ?? null)

export const zboxOperationSchema = z.object({
	id: z.string().min(1),
	sandboxId: nullableString,
	kind: z.string().min(1),
	status: z.enum(['PENDING', 'RUNNING', 'FINISHED', 'FAILED']),
	error: nullableString,
})
export type ZboxOperation = z.infer<typeof zboxOperationSchema>

export const zboxSandboxSchema = z.object({
	id: z.string().min(1),
	name: nullableString,
	status: z.enum(['CREATING', 'RUNNING', 'PARKING', 'PARKED', 'WAKING', 'FORKING', 'RESTORING', 'FAILED', 'TERMINATED', 'ARCHIVED']),
	baseDigest: z.string(),
	hosts: z.array(
		z.object({
			port: z.number().int(),
			access: z.string(),
			url: z.string(),
		}),
	),
	policyGeneration: z.number().int(),
})
export type ZboxSandbox = z.infer<typeof zboxSandboxSchema>

export const zboxSandboxListSchema = z.object({ items: z.array(zboxSandboxSchema) })

export const zboxSpawnSchema = z.object({ operation: zboxOperationSchema, sandboxes: z.array(zboxSandboxSchema) })

export const zboxWorkspaceSchema = z.object({ version: z.string() })
export type ZboxWorkspace = z.infer<typeof zboxWorkspaceSchema>

export const zboxBaseSchema = z.object({
	digest: z.string().min(1),
	name: nullableString,
	imageRef: z.string(),
	status: z.enum(['PULLING', 'FLATTENING', 'READY', 'FAILED', 'DELETED']),
})
export type ZboxBase = z.infer<typeof zboxBaseSchema>

export const zboxBaseListSchema = z.object({ items: z.array(zboxBaseSchema) })

export const zboxExecResultSchema = z.object({
	stdout: z.string(),
	stderr: z.string(),
	exitCode: z
		.number()
		.int()
		.nullish()
		.transform((value) => value ?? null),
	timedOut: z.boolean(),
	stdoutTruncated: z.boolean(),
	stderrTruncated: z.boolean(),
})
export type ZboxExecResult = z.infer<typeof zboxExecResultSchema>

export const zboxSessionSchema = z.object({
	id: z.string().min(1),
	status: z.enum(['OPEN', 'CLOSED', 'FAILED']),
	exitCode: z
		.number()
		.int()
		.nullish()
		.transform((value) => value ?? null),
	hasOutput: z.boolean(),
})
export type ZboxSession = z.infer<typeof zboxSessionSchema>

export const zboxSuccessSchema = z.object({ success: z.literal(true) })

export type ZboxNetworkMode = 'AIRGAPPED' | 'PROJECT' | 'INTERNET' | 'PROJECT_INTERNET'
export type ZboxPortAccess = 'PROJECT' | 'MEMBERS' | 'TICKET' | 'TOKEN' | 'PUBLIC'

export interface ZboxIngressPort {
	port: number
	access: ZboxPortAccess
	wakeOnRequest: boolean
}

/** No `env`: a credential reaches a sandbox only in the root-only file a deploy writes through the file API. */
export interface ZboxLaunch {
	entrypoint?: string[]
	cmd?: string[]
	workingDir?: string
}

export interface ZboxCreateSandboxInput {
	name: string
	baseDigest: string
	cpus: number
	memoryBytes: number
	networkMode: ZboxNetworkMode
	launch: ZboxLaunch
	ports: ZboxIngressPort[]
	/** Reused on a retry so Box answers the first create instead of making a second sandbox. */
	idempotencyKey: string
}

/** No `env`, for the same reason as `ZboxLaunch`. */
export interface ZboxExecInput {
	command: string[]
	workingDir?: string
	timeoutSeconds?: number
}

export interface ZboxProcessInput {
	command: string[]
	workingDir?: string
}

export type ZboxBody = Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>

export type ZboxFetch = (
	input: string,
	init: { method: string; headers: Record<string, string>; body?: string | ZboxBody; signal: AbortSignal },
) => Promise<Response>

export interface ZboxClientOptions {
	/** The API origin; requests go to `<baseUrl>/api/rest/…`. */
	baseUrl: string
	/** The Workspace API key, sent as `Authorization: Bearer`. Never logged. */
	apiKey: string
	fetch?: ZboxFetch
	/** Generates the `Idempotency-Key` of a call whose caller supplied none. */
	idempotencyKey?: () => string
}

export interface ZboxAwaitOptions {
	signal?: AbortSignal
	/** Milliseconds from now after which waiting gives up. */
	deadlineMs: number
}

export interface ZboxClient {
	getWorkspace(signal?: AbortSignal): Promise<ZboxWorkspace>
	pullBase(input: { imageRef: string; name: string }, signal?: AbortSignal): Promise<ZboxOperation>
	buildBase(input: { context: ZboxBody; name: string }, signal?: AbortSignal): Promise<ZboxOperation>
	listBases(signal?: AbortSignal): Promise<ZboxBase[]>
	getOperation(id: string, waitSeconds: number, signal?: AbortSignal): Promise<ZboxOperation>
	awaitOperation(operation: ZboxOperation, options: ZboxAwaitOptions): Promise<ZboxOperation>
	createSandbox(input: ZboxCreateSandboxInput, signal?: AbortSignal): Promise<{ operation: ZboxOperation; sandbox: ZboxSandbox }>
	getSandbox(id: string, signal?: AbortSignal): Promise<ZboxSandbox>
	findSandboxByName(name: string, signal?: AbortSignal): Promise<ZboxSandbox | null>
	deleteSandbox(id: string, idempotencyKey: string, signal?: AbortSignal): Promise<void>
	park(id: string, input: { memory: boolean }, signal?: AbortSignal): Promise<ZboxOperation>
	wake(id: string, signal?: AbortSignal): Promise<ZboxOperation>
	exec(id: string, input: ZboxExecInput, signal?: AbortSignal): Promise<ZboxExecResult>
	startProcess(id: string, input: ZboxProcessInput, signal?: AbortSignal): Promise<ZboxSession>
	getSession(id: string, signal?: AbortSignal): Promise<ZboxSession>
	sessionOutput(id: string, signal?: AbortSignal): Promise<Uint8Array>
	/** `mode` is the octal file mode (Box defaults to 0644). */
	putFile(id: string, path: string, body: ZboxBody, options?: { mode?: string; signal?: AbortSignal }): Promise<void>
	getFile(id: string, path: string, signal?: AbortSignal): Promise<Uint8Array | null>
}
