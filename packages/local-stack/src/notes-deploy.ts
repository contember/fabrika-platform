// Registering and deploying Notes through Control, as `local:smoke` and the browser seeds do: the namespace, the app
// registration from the compiled Zerops manifest, and the signed push to the keyed connection's scoped webhook.

import { normalizeRepoUrl } from '@fabrika/control/repo-source'
import { compileFabrikaManifest, createZeropsArtifactSourceDescriptor, zeropsArtifactCodec } from '@fabrika/provider-zerops'
import cheapNotesConfig from 'fabrika-example-zerops/fabrika.cheap.config'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { composeOutput } from './compose'
import {
	LOCAL_SOURCE_APPLICATION_REPOSITORY_URL,
	LOCAL_SOURCE_BRANCH_HEAD_FILE,
	type LocalSourceBranchHead,
	type LocalSourceManifest,
} from './local-source-contract'
import { LOCAL_NOTES_ENVIRONMENT, STATE_DIR } from './prepare'
import { itemsResponseSchema, rpcResponseSchema } from './response-schemas'
import {
	appSourceSchema,
	environmentViewSchema,
	errorResponseSchema,
	namespacePlanSchema,
	namespaceViewSchema,
	runViewSchema,
	webhookTriggeredSchema,
} from './smoke-schemas'
import { LOCAL_SOURCE_CONNECTIONS } from './source-connection-fixture'
import { parseSnapshot } from './zerops-emulator/snapshot'

export const CONTROL_ORIGIN = 'http://control.fabrika.localhost:18080'
export const NOTES_APP_ID = 'notes'
const NOTES_ENVIRONMENT = LOCAL_NOTES_ENVIRONMENT
export const NOTES_DEPLOY_SERVICE = 'notesapi'
const NOTES_TRIGGER_REF = 'refs/heads/main'
// The keyed connection the notes app is bound to; its scoped route is the only one that can trigger it.
const NOTES_SOURCE_CONNECTION = LOCAL_SOURCE_CONNECTIONS[0]
if (NOTES_SOURCE_CONNECTION === undefined) throw new Error('the local source connection fixture is empty')
const POLL_INTERVAL_MS = 200
const POLL_TIMEOUT_MS = 30_000
// Six sequential user-data syncs follow proxy synchronization and import; build submission can retry sync conflicts.
export const DURABLE_BUILD_WAIT_MS = 120_000

export const envValue = (path: string, name: string): string => {
	const line = readFileSync(path, 'utf8')
		.split(/\r?\n/)
		.find((candidate) => candidate.startsWith(`${name}=`))
	const value = line?.slice(name.length + 1)
	if (value === undefined || value === '') {
		throw new Error(`${name} is missing from ${path}`)
	}
	return value
}

export const parseJson = (text: string, description: string): unknown => {
	try {
		return JSON.parse(text)
	} catch {
		throw new Error(`${description} returned invalid JSON`)
	}
}

export const requestJson = async (
	origin: string,
	path: string,
	options: { bearer?: string; body?: unknown; method?: string } = {},
): Promise<unknown> => {
	const headers = new Headers({ accept: 'application/json' })
	const method = options.method ?? (options.body === undefined ? 'GET' : 'POST')
	if (options.bearer !== undefined) {
		headers.set('authorization', `Bearer ${options.bearer}`)
	}
	if (options.body !== undefined) {
		headers.set('content-type', 'application/json')
	}
	if (method !== 'GET' && method !== 'HEAD') {
		headers.set('origin', origin)
	}
	const response = await fetch(`${origin}${path}`, {
		method,
		headers,
		...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
	})
	const text = await response.text()
	let body: unknown = null
	if (text !== '') {
		try {
			body = JSON.parse(text)
		} catch {
			throw new Error(`${method} ${path} returned non-JSON status ${response.status}`)
		}
	}
	if (!response.ok) {
		const failure = errorResponseSchema.safeParse(body)
		throw new Error(`${method} ${path} failed (${response.status}): ${failure.success ? failure.data.error : text}`)
	}
	return body
}

/**
 * A machine call to the control API, through the proxy. The bearer is an IAM-issued `px_` service key
 * because that is the only machine credential the `service` gate can exchange — the provisioning key
 * has no `credentials` row and the proxy refuses it before control sees it.
 */
export const controlRequest = async (method: string, machineKey: string, input?: unknown): Promise<unknown> => {
	const response = rpcResponseSchema.parse(await requestJson(CONTROL_ORIGIN, '/api/rpc', { bearer: machineKey, body: { method, input } }))
	if (response.result === undefined) throw new Error(`Control RPC ${method} was refused`)
	return response.result
}

export const poll = async <T>(
	description: string,
	read: () => Promise<T>,
	done: (value: T) => boolean,
	options: { timeoutMs?: number; now?: () => number; sleep?: (ms: number) => Promise<unknown> } = {},
): Promise<T> => {
	const now = options.now ?? Date.now
	const sleep = options.sleep ?? Bun.sleep
	const deadline = now() + (options.timeoutMs ?? POLL_TIMEOUT_MS)
	while (now() < deadline) {
		const value = await read()
		if (done(value)) {
			return value
		}
		await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - now())))
	}
	throw new Error(`timed out waiting for ${description}`)
}

/** Provisioning runs behind the control queue now, so the request only enqueues it (backlog 74). */
const namespaceIsReady = async (machineKey: string): Promise<void> => {
	const namespace = await poll(
		'deployment namespace apps-prod to become ready',
		async () => namespaceViewSchema.parse(await controlRequest('namespaces.get', machineKey, { namespaceId: 'apps-prod' })),
		(value) => value.state === 'ready' || value.state === 'failed',
	)
	if (namespace.state === 'failed') {
		throw new Error(
			`deployment namespace apps-prod failed to provision: ${String(namespace.lastErrorCode ?? 'unknown')}: ${
				String(namespace.lastError ?? 'no reason recorded')
			}`,
		)
	}
}

export const ensureNamespace = async (machineKey: string): Promise<void> => {
	const namespaces = await controlRequest('namespaces.list', machineKey)
	const existing = itemsResponseSchema.parse(namespaces).items.map((item) => namespaceViewSchema.parse(item)).find((item) => item.id === 'apps-prod')
	if (existing?.state === 'ready') {
		return
	}
	if (existing !== undefined) {
		await controlRequest('namespaces.reconcile', machineKey, { namespaceId: 'apps-prod' })
		await namespaceIsReady(machineKey)
		return
	}
	const plan = await controlRequest('namespaces.plan', machineKey, { id: 'apps-prod', env: 'prod', preset: 'cheap' })
	const namespace = namespacePlanSchema.parse(plan).namespace
	if (namespace === undefined) {
		throw new Error('namespace plan is missing namespace')
	}
	await controlRequest('namespaces.create', machineKey, namespace)
	await namespaceIsReady(machineKey)
}

export const ensureNotesApp = async (machineKey: string, fixtures: LocalSourceManifest): Promise<void> => {
	const apps = await controlRequest('apps.list', machineKey)
	const sourceDescriptor = await createZeropsArtifactSourceDescriptor(fixtures.application.descriptorContents)
	const manifest = compileFabrikaManifest(cheapNotesConfig, 'prod', sourceDescriptor)
	const target = { provider: 'zerops', version: 2, payload: {} }
	const artifact = {
		provider: 'zerops',
		version: zeropsArtifactCodec.version,
		payload: zeropsArtifactCodec.encode(manifest),
	}
	if (itemsResponseSchema.parse(apps).items.some((item) => namespaceViewSchema.parse(item).id === 'notes')) {
		const app = appSourceSchema.parse(await controlRequest('apps.get', machineKey, { appId: NOTES_APP_ID }))
		if (
			app.repoUrl !== normalizeRepoUrl(LOCAL_SOURCE_APPLICATION_REPOSITORY_URL) || app.workerDir !== '.'
			|| app.githubConnectionId !== NOTES_SOURCE_CONNECTION.connectionId || app.githubInstallationId !== NOTES_SOURCE_CONNECTION.installationId
		) {
			throw new Error('Local notes source uses legacy coordinates or no keyed connection; reset the local stack explicitly')
		}
		const environments = await controlRequest('apps.environments.list', machineKey, { appId: NOTES_APP_ID })
		const existing = itemsResponseSchema.parse(environments).items.map((item) => environmentViewSchema.parse(item)).find((item) => item.env === 'prod')
		if (!isDeepStrictEqual(existing?.artifact, artifact)) {
			throw new Error('Local notes artifact differs from the verified fixture; reset the local stack explicitly')
		}
		if (
			existing?.domain !== 'notes.fabrika.localhost'
			|| existing?.publicOrigin !== 'http://notes.fabrika.localhost:18081'
		) {
			await controlRequest('apps.environments.put', machineKey, {
				appId: NOTES_APP_ID,
				env: NOTES_ENVIRONMENT,
				environment: {
					domain: 'notes.fabrika.localhost',
					publicOrigin: 'http://notes.fabrika.localhost:18081',
					triggerRef: existing?.triggerRef ?? NOTES_TRIGGER_REF,
					namespaceId: existing?.namespaceId ?? 'apps-prod',
					target: existing?.target ?? target,
					artifact: existing?.artifact ?? artifact,
				},
			})
		}
		return
	}
	await controlRequest('register', machineKey, {
		id: 'notes',
		repoUrl: LOCAL_SOURCE_APPLICATION_REPOSITORY_URL,
		defaultBranch: 'main',
		workerDir: '.',
		// Binds the keyed connection that owns the private repository; the registry resolves it by owner.
		githubInstallationId: NOTES_SOURCE_CONNECTION.installationId,
		env: 'prod',
		triggerRef: NOTES_TRIGGER_REF,
		domain: 'notes.fabrika.localhost',
		publicOrigin: 'http://notes.fabrika.localhost:18081',
		namespaceId: 'apps-prod',
		target,
		artifact,
	})
}

/**
 * A signed push to the notes connection's scoped route is the deploy trigger: the route verifies the
 * HMAC with that connection's vault secret and triggers exactly the apps bound to it. The run then
 * resolves and archives the private repository through a token minted with the connection's own App key.
 */
export const triggerByScopedWebhook = async (webhookSecret: string, commitSha: string): Promise<string> => {
	// The push moves `main` in the GitHub double first, as GitHub has moved it before it sends the event.
	const head: LocalSourceBranchHead = { version: 1, commitSha }
	await Bun.write(resolve(STATE_DIR, LOCAL_SOURCE_BRANCH_HEAD_FILE), `${JSON.stringify(head)}\n`)
	const body = JSON.stringify({
		ref: NOTES_TRIGGER_REF,
		after: commitSha,
		repository: { clone_url: LOCAL_SOURCE_APPLICATION_REPOSITORY_URL },
		installation: { id: NOTES_SOURCE_CONNECTION.installationId },
	})
	const signature = createHmac('sha256', webhookSecret).update(body).digest('hex')
	const response = await fetch(`${CONTROL_ORIGIN}/webhooks/github/${NOTES_SOURCE_CONNECTION.connectionId}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-hub-signature-256': `sha256=${signature}`,
		},
		body,
	})
	if (response.status !== 200) {
		throw new Error(`the scoped local webhook answered ${response.status}, not 200 with a triggered run`)
	}
	const triggered = webhookTriggeredSchema.parse(await response.json()).triggered
	const runId = triggered[0]
	if (triggered.length !== 1 || runId === undefined) throw new Error(`the scoped local webhook triggered ${triggered.length} runs, not exactly one`)
	console.info(`Scoped webhook ${NOTES_SOURCE_CONNECTION.connectionId} triggered deploy ${runId}`)
	return runId
}

export const emulatorSnapshot = async () =>
	parseSnapshot(parseJson(
		await composeOutput(['exec', '-T', 'zerops-emulator', 'cat', '/state/zerops.json']),
		'Zerops emulator state',
	))

export type EmulatorSnapshot = Awaited<ReturnType<typeof emulatorSnapshot>>

export const notesServiceId = (snapshot: EmulatorSnapshot): string => {
	const services = snapshot.services.filter((service) => service.name === NOTES_DEPLOY_SERVICE)
	const service = services[0]
	if (services.length !== 1 || service === undefined) throw new Error('Zerops emulator does not contain exactly one notes deploy service')
	return service.id
}

export type RunView = ReturnType<typeof runViewSchema.parse>

/** A run is `running` while Control classifies it, so only the park, a terminal status or the provider's acceptance decides. */
export const waitForParkOrProvider = (machineKey: string, runId: string): Promise<RunView> =>
	poll(
		'the deploy to wait for approval or reach its provider',
		async () => runViewSchema.parse(await controlRequest('runs.get', machineKey, { runId })),
		(value) => value.status === 'awaiting_approval' || value.status === 'failed' || value.externalRunId !== undefined,
		{ timeoutMs: DURABLE_BUILD_WAIT_MS },
	)

/** Wait for a run to finish; anything but `succeeded` throws with the status it ended in. */
export const waitForRunSuccess = async (machineKey: string, runId: string): Promise<RunView> => {
	const run = await poll(
		`deploy ${runId} to finish`,
		async () => runViewSchema.parse(await controlRequest('runs.get', machineKey, { runId })),
		(value) => value.status === 'succeeded' || value.status === 'failed' || value.status === 'cancelled',
		{ timeoutMs: DURABLE_BUILD_WAIT_MS },
	)
	if (run.status !== 'succeeded') throw new Error(`deploy ${runId} ended ${run.status}`)
	return run
}
