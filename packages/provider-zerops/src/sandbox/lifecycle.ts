// The per-workspace sandboxes of a `dev` environment outside a run (`ProviderDevSandboxes`): one Box sandbox per MCP
// workspace on the namespace's sandbox host, found again by its name, so every call converges instead of duplicating.

import {
	PROVIDER_DEV_CAPACITY,
	type ProviderDevSandbox,
	type ProviderDevSandboxes,
	type ProviderEnvironment,
	ProviderNamespaceError,
} from '@fabrika/provider-contract'
import type { Sleeper } from '../collaborators'
import { ZEROPS_APPLICATION_PORT } from '../execution'
import { sandboxUpstreamHost } from '../sandbox-host'
import { isZboxNotFound, isZboxWorkspaceFull, type ZboxClient, ZboxOperationFailed, type ZboxSandbox } from '../zbox'
import { ensureSandboxBase, readSandboxBaseContext, type SandboxBaseContext } from './base-image'
import { SANDBOX_CPUS, SANDBOX_INIT_COMMAND, SANDBOX_MEMORY_BYTES } from './constants'

/** A workspace id is a UUIDv7, so the sandbox name it makes is a fixed shape. */
const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** How long a sandbox in a transition (creating, parking, waking) is waited for. Measured: each takes under 2 s. */
const TRANSITION_DEADLINE_MS = 120_000
const TRANSITION_POLL_MS = 1_000

const TRANSITIONS: ReadonlySet<ZboxSandbox['status']> = new Set(['CREATING', 'PARKING', 'WAKING', 'FORKING', 'RESTORING'])

/** The sandbox name of a workspace: what `ensure` finds it again by. */
export function sandboxName(workspaceId: string): string {
	if (!WORKSPACE_ID.test(workspaceId)) throw new Error('zerops: a workspace id is a lower-case UUID')
	return `fabrika-${workspaceId}`
}

/** A deterministic `Idempotency-Key` in UUID form: the same request after a lost answer gets Box's first answer. */
export function sandboxIdempotencyKey(...parts: readonly string[]): string {
	const hex = new Bun.CryptoHasher('sha256').update(['fabrika-dev-sandbox', ...parts].join('\u0000')).digest('hex')
	const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** A full sandbox host is the operator's to relieve, so it surfaces as the contract's capacity code. */
export async function withSandboxCapacity<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run()
	} catch (error) {
		if (isZboxWorkspaceFull(error) || (error instanceof ZboxOperationFailed && error.code === 'workspaceFull')) {
			throw new ProviderNamespaceError(
				"zerops: the namespace's sandbox host has no room for another running sandbox; park or remove another workspace's sandbox and retry",
				PROVIDER_DEV_CAPACITY,
				true,
			)
		}
		throw error
	}
}

export interface ZeropsDevSandboxesOptions {
	/** The Box client of the environment's namespace sandbox host, authenticated with `sandboxKey`. */
	readonly client: (environment: ProviderEnvironment, sandboxKey: string) => ZboxClient
	readonly sleep: Sleeper
	/** Where `ensure` says it replaced a dead sandbox: the seam has no run log outside a run. */
	readonly log: (line: string) => void
	/** The base image's build context; the one this package ships unless a test passes another. */
	readonly baseContext?: () => Promise<SandboxBaseContext>
}

const assertDevEnvironment = (environment: ProviderEnvironment): void => {
	if (environment.kind !== 'dev') throw new Error('zerops: only a dev environment has workspace sandboxes')
}

/** Wait out a transition; answers the sandbox in a settled state. */
export async function settledSandbox(client: ZboxClient, sandbox: ZboxSandbox, sleep: Sleeper, signal: AbortSignal): Promise<ZboxSandbox> {
	const deadline = Date.now() + TRANSITION_DEADLINE_MS
	let current = sandbox
	while (TRANSITIONS.has(current.status)) {
		signal.throwIfAborted()
		if (Date.now() > deadline) throw new Error(`zerops: sandbox ${current.id} stayed ${current.status}`)
		await sleep(TRANSITION_POLL_MS, signal)
		current = await client.getSandbox(current.id, signal)
	}
	return current
}

/** The sandbox running: a parked one is woken, a transition waited out. */
export async function runningSandbox(client: ZboxClient, sandboxId: string, sleep: Sleeper, signal: AbortSignal): Promise<ZboxSandbox> {
	let sandbox = await settledSandbox(client, await existingSandbox(client, sandboxId, signal), sleep, signal)
	if (sandbox.status === 'PARKED') {
		await withSandboxCapacity(() => client.wake(sandbox.id, signal))
		sandbox = await settledSandbox(client, await client.getSandbox(sandbox.id, signal), sleep, signal)
	}
	if (sandbox.status !== 'RUNNING') throw new Error(`zerops: sandbox ${sandbox.id} is ${sandbox.status} and cannot run`)
	return sandbox
}

const existingSandbox = async (client: ZboxClient, sandboxId: string, signal: AbortSignal): Promise<ZboxSandbox> => {
	try {
		return await client.getSandbox(sandboxId, signal)
	} catch (error) {
		if (isZboxNotFound(error)) throw new Error(`zerops: the workspace's sandbox ${sandboxId} no longer exists; bind the workspace again`)
		throw error
	}
}

const sandboxOf = (sandbox: ZboxSandbox): ProviderDevSandbox => ({
	sandboxId: sandbox.id,
	baseDigest: sandbox.baseDigest,
	upstreamHost: sandboxUpstreamHost(sandbox.id),
})

export function createZeropsDevSandboxes(options: ZeropsDevSandboxesOptions): ProviderDevSandboxes {
	const baseContext = options.baseContext ?? readSandboxBaseContext

	const create = async (client: ZboxClient, workspaceId: string, replaced: string | null, signal: AbortSignal): Promise<ZboxSandbox> => {
		const baseDigest = await ensureSandboxBase(client, await baseContext(), { signal, sleep: options.sleep })
		const { sandbox } = await withSandboxCapacity(() =>
			client.createSandbox({
				name: sandboxName(workspaceId),
				baseDigest,
				cpus: SANDBOX_CPUS,
				memoryBytes: SANDBOX_MEMORY_BYTES,
				networkMode: 'INTERNET',
				launch: { entrypoint: SANDBOX_INIT_COMMAND.slice(0, 1), cmd: SANDBOX_INIT_COMMAND.slice(1) },
				ports: [{ port: ZEROPS_APPLICATION_PORT, access: 'PROJECT', wakeOnRequest: true }],
				// The replaced sandbox is part of the request: the key of the first create would answer with the dead one.
				idempotencyKey: sandboxIdempotencyKey('create', workspaceId, baseDigest, replaced ?? ''),
			}, signal)
		)
		return sandbox
	}

	return {
		ensure: async (input) => {
			assertDevEnvironment(input.environment)
			const client = options.client(input.environment, input.sandboxKey)
			const found = await client.findSandboxByName(sandboxName(input.workspaceId), input.signal)
			let replaced: string | null = null
			if (found !== null) {
				const sandbox = await settledSandbox(client, found, options.sleep, input.signal)
				if (sandbox.status !== 'FAILED' && sandbox.status !== 'TERMINATED') {
					// A sandbox on an older base is kept: a new one would change its id, which the published proxy entry names.
					return sandboxOf(await runningSandbox(client, sandbox.id, options.sleep, input.signal))
				}
				await client.deleteSandbox(sandbox.id, sandboxIdempotencyKey('delete', sandbox.id), input.signal)
				replaced = sandbox.id
			}
			const created = await create(client, input.workspaceId, replaced, input.signal)
			if (replaced !== null) {
				options.log(
					`zerops: workspace ${input.workspaceId}'s sandbox ${replaced} had ended; it is replaced by sandbox ${created.id}, with an empty database`,
				)
			}
			return sandboxOf(await runningSandbox(client, created.id, options.sleep, input.signal))
		},
		park: async (input) => {
			assertDevEnvironment(input.environment)
			const client = options.client(input.environment, input.sandboxKey)
			const sandbox = await settledSandbox(client, await existingSandbox(client, input.sandbox.sandboxId, input.signal), options.sleep, input.signal)
			if (sandbox.status === 'PARKED') return
			if (sandbox.status !== 'RUNNING') throw new Error(`zerops: sandbox ${sandbox.id} is ${sandbox.status} and cannot be parked`)
			await client.park(sandbox.id, { memory: true }, input.signal)
		},
		wake: async (input) => {
			assertDevEnvironment(input.environment)
			const client = options.client(input.environment, input.sandboxKey)
			await runningSandbox(client, input.sandbox.sandboxId, options.sleep, input.signal)
		},
		remove: async (input) => {
			assertDevEnvironment(input.environment)
			const client = options.client(input.environment, input.sandboxKey)
			await client.deleteSandbox(input.sandbox.sandboxId, sandboxIdempotencyKey('delete', input.sandbox.sandboxId), input.signal)
		},
	}
}
