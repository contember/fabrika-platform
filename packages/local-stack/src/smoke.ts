import cheapNotesConfig from '@fabrika/example-zerops-app/cheap'
import {
	DEFAULT_OPERATIONS_SERVICE_KEY,
	FABRIKA_APP_ID,
	FABRIKA_ENVIRONMENT,
	FABRIKA_OPERATIONS_DSN,
	FABRIKA_RELEASE,
	FABRIKA_SERVICE_KEY,
	type IngestMessage,
	OPERATIONS_MANAGED_ENVIRONMENT_KEYS,
	operationsEnvelopeUrl,
	operationsReleaseName,
} from '@fabrika/operations-contract'
import { compileFabrikaManifest, zeropsArtifactCodec } from '@fabrika/provider-zerops'
import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { COMPOSE_FILE, REPO_ROOT, STATE_DIR } from './prepare'

const CONTROL_ORIGIN = 'http://control.localhost:18080'
const IAM_ORIGIN = 'http://iam.localhost:18080'
const NOTES_ORIGIN = 'http://notes.localhost:18081'
const OPERATIONS_ORIGIN = 'http://errors.localhost:18080'
const NOTES_APP_ID = 'notes'
const NOTES_ENVIRONMENT = 'prod'
const NOTES_DEPLOY_SERVICE = 'notesapi'
const SMOKE_COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567'
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

const parseJson = (text: string, description: string): unknown => {
	try {
		return JSON.parse(text)
	} catch {
		throw new Error(`${description} returned invalid JSON`)
	}
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

const composeOutput = async (args: string[]): Promise<string> => {
	const process = Bun.spawn(
		['docker', 'compose', '--project-name', 'fabrika-local', '--file', COMPOSE_FILE, ...args],
		{ cwd: REPO_ROOT, stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' },
	)
	const [output, exitCode] = await Promise.all([new Response(process.stdout).text(), process.exited])
	if (exitCode !== 0) {
		throw new Error('docker compose inspection command failed')
	}
	return output
}

const postgresOutput = (database: 'control' | 'operations', sql: string): Promise<string> =>
	composeOutput([
		'exec',
		'-T',
		'platform-db',
		'psql',
		'--username',
		'postgres',
		'--dbname',
		database,
		'--no-align',
		'--tuples-only',
		'--quiet',
		'--command',
		sql,
	])

const poll = async <T>(description: string, read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
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
			triggerRef: 'refs/heads/main',
			domain: 'notes.localhost',
			publicOrigin: 'http://notes.localhost:18081',
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

const triggerNotesWebhook = async (webhookSecret: string): Promise<string> => {
	const body = JSON.stringify({
		ref: 'refs/heads/main',
		after: SMOKE_COMMIT_SHA,
		repository: { clone_url: 'https://github.com/contember/fabrika-platform.git' },
	})
	const signature = createHmac('sha256', webhookSecret).update(body).digest('hex')
	const response = await fetch(`${CONTROL_ORIGIN}/webhooks/github`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-hub-signature-256': `sha256=${signature}`,
		},
		body,
	})
	if (!response.ok) {
		throw new Error(`local webhook failed with status ${response.status}`)
	}
	const value: unknown = await response.json()
	const triggered = requiredArray(value, 'triggered')
	if (triggered.length !== 1 || typeof triggered[0] !== 'string') {
		throw new Error('local webhook did not trigger exactly one deploy')
	}
	return triggered[0]
}

const proveRestartReconciliation = async (
	provisioningKey: string,
	webhookSecret: string,
): Promise<{ runId: string; commitSha: string }> => {
	const runId = await triggerNotesWebhook(webhookSecret)
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
	const completed = await controlRequest(`/runs/${runId}`, provisioningKey)
	const commitSha = requiredString(completed, 'commitSha')
	if (commitSha !== SMOKE_COMMIT_SHA) {
		throw new Error('completed deploy did not preserve the webhook commit')
	}
	return { runId, commitSha }
}

interface ActiveOperationsConfig {
	dsn: string
	ingestProjectId: string
	serviceKey: string
}

const readActiveOperationsConfig = async (): Promise<ActiveOperationsConfig | null> => {
	const output = (await postgresOutput(
		'control',
		`SELECT json_build_object(
				'dsn', dsn,
				'ingestProjectId', ingest_project_id,
				'serviceKey', service_key
			)
			FROM operations_ingest_configs
			WHERE app_id = 'notes'
				AND env = 'prod'
				AND service_key = 'default'
				AND dsn IS NOT NULL
				AND ingest_project_id IS NOT NULL
				AND activated_revision IS NOT NULL`,
	)).trim()
	if (output === '') return null
	const value = parseJson(output, 'Control Operations ingest configuration query')
	return {
		dsn: requiredString(value, 'dsn'),
		ingestProjectId: requiredString(value, 'ingestProjectId'),
		serviceKey: requiredString(value, 'serviceKey'),
	}
}

const activeOperationsConfig = async (): Promise<ActiveOperationsConfig> => {
	const config = await poll(
		'an active Operations ingest configuration',
		readActiveOperationsConfig,
		(value) => value !== null,
	)
	if (config === null) throw new Error('active Operations ingest configuration disappeared')
	return config
}

const proveManagedOperationsEnvironment = async (
	config: ActiveOperationsConfig,
	release: string,
): Promise<void> => {
	const snapshot = parseJson(
		await composeOutput(['exec', '-T', 'zerops-emulator', 'cat', '/state/zerops.json']),
		'Zerops emulator state',
	)
	const services = requiredArray(snapshot, 'services').filter((service) => property(service, 'name') === NOTES_DEPLOY_SERVICE)
	if (services.length !== 1) {
		throw new Error('Zerops emulator does not contain exactly one notes deploy service')
	}
	const serviceId = requiredString(services[0], 'id')
	const managedKeys = new Set<string>([...OPERATIONS_MANAGED_ENVIRONMENT_KEYS, FABRIKA_RELEASE])
	const managed = requiredArray(snapshot, 'serviceEnv').filter(
		(record) => property(record, 'serviceStackId') === serviceId && managedKeys.has(String(property(record, 'key'))),
	)
	const expected = new Map<string, string>([
		[FABRIKA_OPERATIONS_DSN, config.dsn],
		[FABRIKA_APP_ID, NOTES_APP_ID],
		[FABRIKA_ENVIRONMENT, NOTES_ENVIRONMENT],
		[FABRIKA_SERVICE_KEY, DEFAULT_OPERATIONS_SERVICE_KEY],
		[FABRIKA_RELEASE, release],
	])
	if (managed.length !== expected.size) {
		throw new Error('Zerops emulator contains missing, duplicate, or stale managed Operations values')
	}
	for (const [key, expectedValue] of expected) {
		const matches = managed.filter((record) => property(record, 'key') === key)
		if (matches.length !== 1 || property(matches[0], 'content') !== expectedValue) {
			throw new Error(`Zerops emulator managed value ${key} does not match the deploy projection`)
		}
	}
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
	const operationsExitCode = await compose(
		['exec', '-T', 'notes', 'wget', '-qO-', '--timeout=2', 'http://operations:3000/healthz'],
		false,
		false,
	)
	if (operationsExitCode === 0) {
		throw new Error('notes unexpectedly reached the Operations private network')
	}
}

const proveOperationsPublicBoundary = async (): Promise<void> => {
	for (const path of ['/healthz', '/private/catalog/reconcile', '/private/releases/reconcile', '/api/issues']) {
		const response = await fetch(`${OPERATIONS_ORIGIN}${path}`)
		if (response.status !== 403) {
			throw new Error(`public Operations path ${path} returned ${response.status}, expected gateway denial`)
		}
	}
	const ingest = await fetch(`${OPERATIONS_ORIGIN}/api/1/envelope/`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-sentry-envelope' },
		body: '{}\n',
	})
	if (ingest.status !== 401) {
		throw new Error(`public Operations ingest returned ${ingest.status}, expected credential challenge`)
	}
}

const operationsOperatorRequest = async (path: string): Promise<unknown> =>
	parseJson(
		await composeOutput(['exec', '-T', 'operations', 'wget', '-qO-', `http://127.0.0.1:3000${path}`]),
		'Operations operator API',
	)

const matchingIssues = (value: unknown, marker: string): unknown[] =>
	requiredArray(value, 'items').filter((issue) => {
		const title = property(issue, 'title')
		return typeof title === 'string' && title.includes(marker)
	})

const pollMarkerIssue = async (marker: string, expectedCount: number): Promise<unknown> => {
	const response = await poll(
		`Operations issue ${marker} count ${expectedCount}`,
		() => operationsOperatorRequest(`/api/issues?query=${encodeURIComponent(marker)}`),
		(value) => {
			const issues = matchingIssues(value, marker)
			return issues.length === 1 && property(issues[0], 'count') === expectedCount
		},
	)
	const issues = matchingIssues(response, marker)
	const issue = issues[0]
	if (issue === undefined) throw new Error('Operations issue disappeared after polling')
	return issue
}

const eventId = (): string => randomUUID().replaceAll('-', '')

const sentryEvent = (input: {
	eventId: string
	marker: string
	release: string
}): Record<string, unknown> => ({
	event_id: input.eventId,
	level: 'error',
	platform: 'javascript',
	release: input.release,
	environment: NOTES_ENVIRONMENT,
	fingerprint: [input.marker],
	exception: {
		values: [{
			type: 'LocalSmokeError',
			value: input.marker,
			stacktrace: {
				frames: [{
					function: 'proveOperationsSmoke',
					module: 'local-stack',
					filename: 'packages/local-stack/src/smoke.ts',
					lineno: 1,
					in_app: true,
				}],
			},
		}],
	},
})

const sentryEnvelope = (event: Record<string, unknown>): string =>
	`${JSON.stringify({ event_id: property(event, 'event_id'), sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: 'event' })}\n${
		JSON.stringify(event)
	}\n`

const parseDsn = (config: ActiveOperationsConfig): { envelopeUrl: string; publicKey: string } => {
	let dsn: URL
	try {
		dsn = new URL(config.dsn)
	} catch {
		throw new Error('active Operations DSN is invalid')
	}
	const publicKey = decodeURIComponent(dsn.username)
	if (
		dsn.origin !== OPERATIONS_ORIGIN
		|| dsn.password !== ''
		|| !/^[0-9a-f]{32}$/.test(publicKey)
		|| dsn.pathname !== `/${config.ingestProjectId}`
		|| config.serviceKey !== DEFAULT_OPERATIONS_SERVICE_KEY
	) {
		throw new Error('active Operations DSN has unexpected coordinates')
	}
	return {
		envelopeUrl: operationsEnvelopeUrl(OPERATIONS_ORIGIN, config.ingestProjectId),
		publicKey,
	}
}

const readIssueStorageIdentity = async (issueId: string): Promise<{ sourceId: string; fingerprint: string }> => {
	const output = (await postgresOutput(
		'operations',
		`SELECT COALESCE(
				json_agg(json_build_object('id', id, 'sourceId', source_id, 'fingerprint', fingerprint)),
				'[]'::json
			)
			FROM issues
			WHERE id IS NOT NULL`,
	)).trim()
	const rows = parseJson(output, 'Operations issue storage query')
	if (!Array.isArray(rows)) throw new Error('Operations issue storage query returned an invalid result')
	const row = rows.find((candidate) => property(candidate, 'id') === issueId)
	if (row === undefined) throw new Error('operator issue is missing from Operations storage')
	return {
		sourceId: requiredString(row, 'sourceId'),
		fingerprint: requiredString(row, 'fingerprint'),
	}
}

const hex = (value: string): string => [...new TextEncoder().encode(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

const insertDuplicatePendingDeliveries = async (message: IngestMessage): Promise<void> => {
	const payload = hex(JSON.stringify(message))
	const now = Date.now()
	const firstJob = randomUUID()
	const secondJob = randomUUID()
	await postgresOutput(
		'operations',
		`INSERT INTO jobs (id, queue, payload, visible_at, attempts, max_attempts, created_at)
			VALUES
				('${firstJob}', 'operations-ingest', convert_from(decode('${payload}', 'hex'), 'UTF8'), ${now}, 0, 6, ${now}),
				('${secondJob}', 'operations-ingest', convert_from(decode('${payload}', 'hex'), 'UTF8'), ${now}, 0, 6, ${now})`,
	)
	const pending = Number((await postgresOutput(
		'operations',
		"SELECT COUNT(*) FROM jobs WHERE queue = 'operations-ingest'",
	)).trim())
	if (pending !== 2) throw new Error('Operations queue did not persist both duplicate deliveries')
}

const operationsQueueDepth = async (): Promise<number> => {
	const value = Number((await postgresOutput(
		'operations',
		"SELECT COUNT(*) FROM jobs WHERE queue = 'operations-ingest'",
	)).trim())
	if (!Number.isSafeInteger(value) || value < 0) throw new Error('Operations queue returned an invalid depth')
	return value
}

const proveOperationsIngestPersistence = async (
	config: ActiveOperationsConfig,
	release: string,
): Promise<void> => {
	const marker = `local-operations-smoke-${Date.now()}`
	const firstEventId = eventId()
	const firstEvent = sentryEvent({ eventId: firstEventId, marker, release })
	const ingest = parseDsn(config)
	const response = await fetch(ingest.envelopeUrl, {
		method: 'POST',
		headers: {
			'content-type': 'application/x-sentry-envelope',
			'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${ingest.publicKey}`,
		},
		body: sentryEnvelope(firstEvent),
	})
	if (response.status !== 202) {
		throw new Error(`Operations envelope route returned ${response.status}, expected 202`)
	}

	const firstIssue = await pollMarkerIssue(marker, 1)
	const issueId = requiredString(firstIssue, 'id')
	const source = property(firstIssue, 'source')
	if (
		property(source, 'appId') !== NOTES_APP_ID
		|| property(source, 'environment') !== NOTES_ENVIRONMENT
		|| property(source, 'serviceKey') !== DEFAULT_OPERATIONS_SERVICE_KEY
	) {
		throw new Error('Operations issue has incorrect source coordinates')
	}
	const identity = await readIssueStorageIdentity(issueId)
	const duplicateEventId = eventId()
	const duplicateEvent = sentryEvent({ eventId: duplicateEventId, marker, release })
	const duplicateMessage: IngestMessage = {
		projectId: identity.sourceId,
		fingerprint: identity.fingerprint,
		eventId: duplicateEventId,
		title: `LocalSmokeError: ${marker}`,
		culprit: 'proveOperationsSmoke',
		level: 'error',
		release,
		environment: NOTES_ENVIRONMENT,
		receivedAt: Date.now(),
		payload: duplicateEvent,
	}

	await compose(['stop', 'operations'])
	await insertDuplicatePendingDeliveries(duplicateMessage)
	await compose(['up', '--detach', '--wait', 'operations'])

	const repeatedIssue = await pollMarkerIssue(marker, 2)
	if (requiredString(repeatedIssue, 'id') !== issueId) {
		throw new Error('duplicate delivery changed the Operations issue identity')
	}
	await poll('the Operations ingest queue to drain', operationsQueueDepth, (depth) => depth === 0)
}

const main = async (): Promise<void> => {
	const provisioningKey = envValue(resolve(STATE_DIR, 'iam.env'), 'PROPUSTKA_PROVISIONING_KEY')
	const webhookSecret = envValue(resolve(STATE_DIR, 'control.env'), 'GITHUB_WEBHOOK_SECRET')
	await requestJson(CONTROL_ORIGIN, '/healthz')
	await requestJson(IAM_ORIGIN, '/healthz')
	await requestJson(NOTES_ORIGIN, '/healthz')
	await proveOperationsPublicBoundary()
	await requestJson(CONTROL_ORIGIN, '/api/namespaces')
	await ensureNamespace(provisioningKey)
	await ensureNotesApp(provisioningKey)
	const activeConfig = await activeOperationsConfig()
	const deployment = await proveRestartReconciliation(provisioningKey, webhookSecret)
	const deployedConfig = await activeOperationsConfig()
	if (
		deployedConfig.dsn !== activeConfig.dsn
		|| deployedConfig.ingestProjectId !== activeConfig.ingestProjectId
		|| deployedConfig.serviceKey !== activeConfig.serviceKey
	) {
		throw new Error('active Operations ingest configuration changed during deploy')
	}
	const release = operationsReleaseName({
		appId: NOTES_APP_ID,
		environment: NOTES_ENVIRONMENT,
		serviceKey: DEFAULT_OPERATIONS_SERVICE_KEY,
		commitSha: deployment.commitSha,
	})
	await proveManagedOperationsEnvironment(deployedConfig, release)
	await proveOperationsIngestPersistence(deployedConfig, release)
	await proveIamAndNotes(provisioningKey)
	await proveNamespaceIsolation()
	console.info(`Local stack smoke passed (run ${deployment.runId})`)
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : 'local stack smoke failed')
	process.exit(1)
})
