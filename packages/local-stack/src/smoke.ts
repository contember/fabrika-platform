import cheapNotesConfig from '@fabrika/example-zerops-app/cheap'
import { compileFabrikaManifest, zeropsArtifactCodec } from '@fabrika/provider-zerops'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { COMPOSE_FILE, REPO_ROOT, STATE_DIR } from './prepare'

const CONTROL_ORIGIN = 'http://control.localhost:18080'
const IAM_ORIGIN = 'http://iam.localhost:18080'
const NOTES_ORIGIN = 'http://notes.localhost:18081'
const EXTERNAL_ACTIVATION_WAIT_MS = 11_000
const POLL_INTERVAL_MS = 200
const POLL_TIMEOUT_MS = 30_000

const property = (value: unknown, key: string): unknown =>
	typeof value === 'object' && value !== null && key in value ? Reflect.get(value, key) : undefined

const requiredString = (value: unknown, key: string): string => {
	const found = property(value, key)
	if (typeof found !== 'string' || found === '') {
		throw new Error(`response is missing ${key}`)
	}
	return found
}

const requiredArray = (value: unknown, key: string): unknown[] => {
	const found = property(value, key)
	if (!Array.isArray(found)) {
		throw new Error(`response is missing ${key}`)
	}
	return found
}

const envValue = (path: string, name: string): string => {
	const line = readFileSync(path, 'utf8')
		.split(/\r?\n/)
		.find((candidate) => candidate.startsWith(`${name}=`))
	const value = line?.slice(name.length + 1)
	if (value === undefined || value === '') {
		throw new Error(`${name} is missing from ${path}`)
	}
	return value
}

const requestJson = async (
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
		const message = property(body, 'error')
		throw new Error(`${method} ${path} failed (${response.status}): ${typeof message === 'string' ? message : text}`)
	}
	return body
}

const controlRequest = (path: string, provisioningKey: string, options: { body?: unknown; method?: string } = {}): Promise<unknown> =>
	requestJson(CONTROL_ORIGIN, `/api${path}`, { bearer: provisioningKey, ...options })

const compose = async (args: string[], expectSuccess = true, showOutput = true): Promise<number> => {
	const process = Bun.spawn(
		['docker', 'compose', '--project-name', 'fabrika-local', '--file', COMPOSE_FILE, ...args],
		{ cwd: REPO_ROOT, stdout: showOutput ? 'inherit' : 'ignore', stderr: showOutput ? 'inherit' : 'ignore', stdin: 'ignore' },
	)
	const exitCode = await process.exited
	if (expectSuccess && exitCode !== 0) {
		throw new Error(`docker compose ${args.join(' ')} failed with exit code ${exitCode}`)
	}
	return exitCode
}

const poll = async (description: string, read: () => Promise<unknown>, done: (value: unknown) => boolean): Promise<unknown> => {
	const deadline = Date.now() + POLL_TIMEOUT_MS
	while (Date.now() < deadline) {
		const value = await read()
		if (done(value)) {
			return value
		}
		await Bun.sleep(POLL_INTERVAL_MS)
	}
	throw new Error(`timed out waiting for ${description}`)
}

const ensureNamespace = async (provisioningKey: string): Promise<void> => {
	const namespaces = await controlRequest('/namespaces', provisioningKey)
	const existing = requiredArray(namespaces, 'items').find((item) => property(item, 'id') === 'apps-prod')
	if (property(existing, 'state') === 'ready') {
		return
	}
	if (existing !== undefined) {
		await controlRequest('/namespaces/apps-prod/reconcile', provisioningKey, { body: {} })
		return
	}
	const plan = await controlRequest('/namespaces/plan', provisioningKey, {
		body: { id: 'apps-prod', env: 'prod', preset: 'cheap' },
	})
	const namespace = property(plan, 'namespace')
	if (namespace === undefined) {
		throw new Error('namespace plan is missing namespace')
	}
	await controlRequest('/namespaces', provisioningKey, { body: namespace })
}

const ensureNotesApp = async (provisioningKey: string): Promise<void> => {
	const apps = await controlRequest('/apps', provisioningKey)
	if (requiredArray(apps, 'items').some((item) => property(item, 'id') === 'notes')) {
		return
	}
	const manifest = compileFabrikaManifest(cheapNotesConfig, 'prod')
	await controlRequest('/register-app', provisioningKey, {
		body: {
			id: 'notes',
			repoUrl: 'https://github.com/contember/fabrika-platform.git',
			defaultBranch: 'main',
			workerDir: 'examples/zerops-app',
			env: 'prod',
			domain: 'notes.localhost',
			namespaceId: 'apps-prod',
			target: { provider: 'zerops', version: 2, payload: {} },
			artifact: {
				provider: 'zerops',
				version: zeropsArtifactCodec.version,
				payload: zeropsArtifactCodec.encode(manifest),
			},
		},
	})
}

const proveRestartReconciliation = async (provisioningKey: string): Promise<string> => {
	const run = await controlRequest('/deploy', provisioningKey, { body: { appId: 'notes', env: 'prod' } })
	const runId = requiredString(run, 'id')
	await poll(
		'a provider-owned running deploy',
		() => controlRequest(`/runs/${runId}`, provisioningKey),
		(value) => property(value, 'status') === 'running' && typeof property(value, 'externalRunId') === 'string',
	)
	console.info(`Deploy ${runId} reached the external Zerops pipeline; killing control`)
	await compose(['kill', 'control'])
	await Bun.sleep(EXTERNAL_ACTIVATION_WAIT_MS)
	await compose(['up', '--detach', '--wait', 'control'])
	await poll(
		'startup reconciliation',
		() => controlRequest(`/runs/${runId}`, provisioningKey),
		(value) => property(value, 'status') === 'succeeded',
	)
	return runId
}

const proveIamAndNotes = async (provisioningKey: string): Promise<void> => {
	const schema = await requestJson(IAM_ORIGIN, '/admin/apps/notes/schema', { bearer: provisioningKey })
	if (requiredArray(schema, 'actions').length !== 4 || requiredArray(schema, 'scopes').length !== 1) {
		throw new Error('notes IAM schema was not reconciled')
	}
	const keyResponse = await requestJson(IAM_ORIGIN, '/admin/api-keys', {
		bearer: provisioningKey,
		body: {
			label: `local smoke ${new Date().toISOString()}`,
			type: 'service',
			app: 'notes',
			permissions: ['notes.read', 'notes.write'],
			scopeType: 'workspace',
			scopeValue: 'local',
		},
	})
	const apiKey = requiredString(keyResponse, 'apiKey')
	const principalId = requiredString(keyResponse, 'principalId')
	try {
		const publicResponse = await requestJson(NOTES_ORIGIN, '/public/status')
		if (property(publicResponse, 'app') !== 'notes') {
			throw new Error('public notes route returned the wrong app')
		}
		const title = `local smoke ${Date.now()}`
		const created = await requestJson(NOTES_ORIGIN, '/api/notes?workspace=local', {
			bearer: apiKey,
			body: { title },
		})
		if (property(property(created, 'note'), 'title') !== title) {
			throw new Error('authenticated note creation returned the wrong title')
		}
		const listed = await requestJson(NOTES_ORIGIN, '/api/notes?workspace=local', { bearer: apiKey })
		if (!requiredArray(listed, 'notes').some((note) => property(note, 'title') === title)) {
			throw new Error('authenticated note was not persisted')
		}
	} finally {
		await requestJson(IAM_ORIGIN, `/admin/api-keys/${principalId}`, {
			bearer: provisioningKey,
			method: 'DELETE',
		})
	}
}

const proveNamespaceIsolation = async (): Promise<void> => {
	const exitCode = await compose(
		['exec', '-T', 'notes', 'wget', '-qO-', '--timeout=2', 'http://control:3000/healthz'],
		false,
		false,
	)
	if (exitCode === 0) {
		throw new Error('notes unexpectedly reached the control plane private network')
	}
}

const main = async (): Promise<void> => {
	const provisioningKey = envValue(resolve(STATE_DIR, 'iam.env'), 'PROPUSTKA_PROVISIONING_KEY')
	await requestJson(CONTROL_ORIGIN, '/healthz')
	await requestJson(IAM_ORIGIN, '/healthz')
	await requestJson(NOTES_ORIGIN, '/healthz')
	await requestJson(CONTROL_ORIGIN, '/api/namespaces')
	await ensureNamespace(provisioningKey)
	await ensureNotesApp(provisioningKey)
	const runId = await proveRestartReconciliation(provisioningKey)
	await proveIamAndNotes(provisioningKey)
	await proveNamespaceIsolation()
	console.info(`Local stack smoke passed (run ${runId})`)
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : 'local stack smoke failed')
	process.exit(1)
})
