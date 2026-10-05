import cheapNotesConfig from '@fabrika/example-zerops-app/cheap'
import {
	DEFAULT_OPERATIONS_SERVICE_KEY,
	FABRIKA_APP_ID,
	FABRIKA_ENVIRONMENT,
	FABRIKA_OPERATIONS_DSN,
	FABRIKA_RELEASE,
	FABRIKA_SERVICE_KEY,
	type IngestMessage,
	operationsEnvelopeUrl,
	operationsReleaseName,
} from '@fabrika/operations-contract'
import {
	compileFabrikaManifest,
	createZeropsArtifactSourceDescriptor,
	zeropsArtifactCodec,
	zeropsNamespaceTargetCodec,
} from '@fabrika/provider-zerops'
import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { normalizeRepoUrl } from '../../control/src/repo-source'
import { DEPLOY_LEASE_TTL_MS } from '../../control/src/run-ownership'
import { confirmStagedManagedBinding } from '../../provider-zerops/src/managed-environment/admission'
import { type ManagedCheckpoint, type ManagedKey, verifyManagedCheckpoint } from '../../provider-zerops/src/managed-environment/protocol'
import {
	LOCAL_SOURCE_APPLICATION_REPOSITORY_URL,
	LOCAL_SOURCE_FIXTURE_DIRECTORY,
	LOCAL_SOURCE_PLATFORM_REPOSITORY,
	type LocalSourceManifest,
} from './local-source-contract'
import { loadLocalSourceFixtures } from './local-source-fixtures/fixture'
import { requireMachineKey } from './machine-key'
import { COMPOSE_FILE, REPO_ROOT, STATE_DIR } from './prepare'
import { idResponseSchema, itemsResponseSchema, rpcResponseSchema } from './response-schemas'
import {
	activeOperationsConfigSchema,
	appSourceSchema,
	completedRunSchema,
	createdNoteSchema,
	deployLeaseSchema,
	environmentViewSchema,
	errorResponseSchema,
	iamSchemaResponseSchema,
	issueListSchema,
	keyPrincipalSchema,
	namespacePlanSchema,
	namespaceTargetViewSchema,
	namespaceViewSchema,
	notesListSchema,
	publicStatusSchema,
	runViewSchema,
	storageIdentitySchema,
	storageRowsSchema,
} from './smoke-schemas'
import { LOCAL_SOURCE_CONNECTIONS } from './source-connection-fixture'
import { parseSnapshot } from './zerops-emulator/snapshot'

const CONTROL_ORIGIN = 'http://control.fabrika.localhost:18080'
const IAM_ORIGIN = 'http://iam.fabrika.localhost:18080'
const NOTES_ORIGIN = 'http://notes.fabrika.localhost:18081'
const OPERATIONS_ORIGIN = 'http://errors.fabrika.localhost:18080'
const NOTES_APP_ID = 'notes'
const NOTES_ENVIRONMENT = 'prod'
const NOTES_DEPLOY_SERVICE = 'notesapi'
// The keyed connection the notes app is bound to; its scoped route is the only one that can trigger it.
const NOTES_SOURCE_CONNECTION = LOCAL_SOURCE_CONNECTIONS[0]
if (NOTES_SOURCE_CONNECTION === undefined) throw new Error('the local source connection fixture is empty')
const EXTERNAL_ACTIVATION_WAIT_MS = 11_000
const POLL_INTERVAL_MS = 200
const POLL_TIMEOUT_MS = 30_000

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
		{ cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
	)
	const [output, failure, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	])
	if (exitCode !== 0) {
		// Name the service and what docker said. `args` itself is not echoed: it carries the SQL, and a
		// bare "inspection command failed" costs a whole re-run to diagnose.
		throw new Error(`docker compose ${args[0] ?? 'command'} ${args[2] ?? ''} failed (${exitCode}): ${failure.trim().split('\n')[0] ?? ''}`)
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

const ensureNamespace = async (machineKey: string): Promise<void> => {
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

const ensureNotesApp = async (machineKey: string, fixtures: LocalSourceManifest): Promise<void> => {
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
		if (app.repoUrl !== normalizeRepoUrl(LOCAL_SOURCE_APPLICATION_REPOSITORY_URL) || app.workerDir !== '.') {
			throw new Error('Local notes source uses legacy coordinates; reset the local stack explicitly')
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
					triggerRef: existing?.triggerRef ?? 'refs/heads/main',
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
		env: 'prod',
		triggerRef: 'refs/heads/main',
		domain: 'notes.fabrika.localhost',
		publicOrigin: 'http://notes.fabrika.localhost:18081',
		namespaceId: 'apps-prod',
		target,
		artifact,
	})
}

/**
 * The scoped route resolves the connection's vault secret and verifies the HMAC before anything else,
 * so a 204 proves the signature was accepted. It cannot prove more here: `notes` is registered
 * anonymously because no local app can hold a keyed private binding (see backlog 81), so the delivery
 * matches no application and `handleWebhook` acknowledges it with an empty body.
 */
const proveScopedWebhookSignature = async (webhookSecret: string, commitSha: string): Promise<void> => {
	const body = JSON.stringify({
		ref: 'refs/heads/main',
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
	if (response.status !== 204) {
		throw new Error(`the scoped local webhook answered ${response.status}, not the expected 204`)
	}
	console.info(`Scoped webhook ${NOTES_SOURCE_CONNECTION.connectionId} verified the delivery signature`)
}

const emulatorSnapshot = async () =>
	parseSnapshot(parseJson(
		await composeOutput(['exec', '-T', 'zerops-emulator', 'cat', '/state/zerops.json']),
		'Zerops emulator state',
	))

const readRunCheckpoint = async (runId: string): Promise<ManagedCheckpoint | null> => {
	const output =
		(await postgresOutput('control', `SELECT provider_state_json FROM runs WHERE id = convert_from(decode('${hex(runId)}', 'hex'), 'UTF8')`)).trim()
	return output === '' ? null : verifyManagedCheckpoint(parseJson(output, 'provider checkpoint'))
}

export const waitForDeployLeaseExpiry = async (
	read: () => Promise<{ expiresAt: number } | null>,
	timing: { now: () => number; sleep: (ms: number) => Promise<unknown> } = { now: Date.now, sleep: Bun.sleep },
): Promise<void> => {
	const deadline = timing.now() + DEPLOY_LEASE_TTL_MS + 60_000
	let announced = false
	for (;;) {
		const lease = await read()
		const now = timing.now()
		if (lease === null || lease.expiresAt <= now) return
		if (now >= deadline) throw new Error('Timed out waiting for the killed Control invocation’s deploy lease to expire naturally')
		if (!announced) {
			console.info(
				`Waiting for persisted deploy lease expiry at ${new Date(lease.expiresAt).toISOString()} (timeout in ${
					Math.ceil((deadline - now) / 60_000)
				} minutes; no lease mutation)`,
			)
			announced = true
		}
		await timing.sleep(Math.min(30_000, lease.expiresAt - now + 1000, deadline - now))
	}
}

const readNotesDeployLease = async () =>
	deployLeaseSchema.parse(parseJson(
		(await postgresOutput(
			'control',
			`SELECT COALESCE(
		(SELECT json_build_object('expiresAt', expires_at) FROM deploy_locks WHERE lock_key = '${NOTES_APP_ID}:${NOTES_ENVIRONMENT}'),
		'null'::json
	)`,
		)).trim(),
		'Control deploy lease query',
	))

const proveNamespaceSource = async (machineKey: string, fixtures: LocalSourceManifest): Promise<void> => {
	const view = namespaceTargetViewSchema.parse(await controlRequest('namespaces.get', machineKey, { namespaceId: 'apps-prod' }))
	if (view.target.provider !== 'zerops' || view.target.version !== zeropsNamespaceTargetCodec.version) {
		throw new Error('Unexpected namespace target version')
	}
	const target = zeropsNamespaceTargetCodec.decode(view.target.payload)
	const expected = {
		repository: LOCAL_SOURCE_PLATFORM_REPOSITORY,
		commitSha: fixtures.platform.commitSha,
		descriptor: await createZeropsArtifactSourceDescriptor(fixtures.platform.descriptorContents),
	}
	if (!isDeepStrictEqual(target.proxySource, expected)) throw new Error('Namespace source pin differs from verified fixture; explicit reset required')
	const deployed = target.proxyDeployment
	if (
		deployed === undefined || target.proxyBuild !== undefined || deployed.commitSha !== expected.commitSha
		|| deployed.descriptorSha256 !== expected.descriptor.sha256 || !isDeepStrictEqual(deployed.repository, expected.repository)
	) {
		throw new Error('Namespace proxy deployment does not match its immutable source pin')
	}
	const snapshot = await emulatorSnapshot()
	const version = snapshot.appVersions.find(item => item.id === deployed.appVersionId)
	const grant = snapshot.uploadGrants.find(item => item.appVersionId === deployed.appVersionId)
	if (
		version?.status !== 'ACTIVE' || version.serviceStackId !== target.proxyServiceId || version.projectId !== target.projectId
		|| grant?.deleted !== false || grant.receipt === undefined
		|| snapshot.services.find(item => item.id === target.proxyServiceId)?.activeAppVersionId !== deployed.appVersionId
		|| snapshot.processes.filter(item => item.actionName === 'stack.build' && item.appVersionId === deployed.appVersionId).length !== 1
	) {
		throw new Error('Namespace proxy lacks exact-version upload and build evidence')
	}
}

const proveRestartReconciliation = async (
	machineKey: string,
	fixtures: LocalSourceManifest,
): Promise<{ runId: string; commitSha: string; checkpoint: ManagedCheckpoint }> => {
	// Manual, not webhook-driven: triggering by delivery needs an app bound to a keyed connection.
	console.info(`Submitting immutable Notes deploy for ${fixtures.application.commitSha}`)
	const triggered = await controlRequest('deploy', machineKey, { appId: NOTES_APP_ID, env: NOTES_ENVIRONMENT, ref: fixtures.application.commitSha })
	const runId = idResponseSchema.parse(triggered).id
	console.info(`Deploy ${runId} accepted; waiting for its durable build_triggered checkpoint`)
	let observedPhase: string | undefined
	const checkpoint = await poll(
		'a durable build_triggered checkpoint',
		async () => {
			const checkpoint = await readRunCheckpoint(runId)
			const phase = checkpoint?.phase ?? 'no checkpoint yet'
			if (phase !== observedPhase) {
				console.info(`Deploy ${runId}: ${phase}`)
				observedPhase = phase
			}
			const run = runViewSchema.parse(await controlRequest('runs.get', machineKey, { runId }))
			if (run.status === 'failed' || run.status === 'cancelled') {
				throw new Error(`Deploy ${runId} became ${run.status} before the hard-kill witness (${phase})`)
			}
			return checkpoint
		},
		(value) => value?.phase === 'build_triggered',
	)
	if (
		checkpoint?.phase !== 'build_triggered' || checkpoint.processId === undefined
		|| checkpoint.runId !== runId || checkpoint.sourceCommitSha !== fixtures.application.commitSha
		|| checkpoint.descriptorSha256 !== fixtures.application.descriptorSha256
		|| checkpoint.appId !== NOTES_APP_ID || checkpoint.environment !== NOTES_ENVIRONMENT || checkpoint.namespaceId !== 'apps-prod'
		|| checkpoint.hostname !== NOTES_DEPLOY_SERVICE || checkpoint.setup !== NOTES_DEPLOY_SERVICE
	) throw new Error('Submitted run source identity mismatch')
	const running = runViewSchema.parse(await controlRequest('runs.get', machineKey, { runId }))
	if (running.status !== 'running' || running.externalRunId !== checkpoint.appVersionId) {
		throw new Error('Run version differs from submitted checkpoint')
	}
	const submitted = await emulatorSnapshot()
	const receipt = submitted.uploadGrants.find(item => item.appVersionId === checkpoint.appVersionId)
	const version = submitted.appVersions.find(item => item.id === checkpoint.appVersionId)
	if (
		receipt?.deleted !== false || receipt.receipt === undefined
		|| version?.status !== 'BUILDING' || version.serviceStackId !== checkpoint.serviceId || version.projectId !== checkpoint.projectId
		|| !submitted.processes.some(item =>
			item.id === checkpoint.processId && item.appVersionId === checkpoint.appVersionId && item.actionName === 'stack.build'
		)
	) {
		throw new Error('Submitted run has no completed upload or matching build process')
	}
	console.info(`Deploy ${runId} reached the external Zerops pipeline; killing control`)
	await compose(['kill', 'control'])
	await waitForDeployLeaseExpiry(readNotesDeployLease)
	await Bun.sleep(EXTERNAL_ACTIVATION_WAIT_MS)
	await compose(['up', '--detach', '--wait', 'control'])
	await poll(
		'startup reconciliation',
		async () => runViewSchema.parse(await controlRequest('runs.get', machineKey, { runId })),
		(value) => value.status === 'succeeded',
	)
	const completed = await controlRequest('runs.get', machineKey, { runId })
	const commitSha = completedRunSchema.parse(completed).commitSha
	if (commitSha !== fixtures.application.commitSha) {
		throw new Error('completed deploy did not record the resolved commit')
	}
	const recovered = await readRunCheckpoint(runId)
	const snapshot = await emulatorSnapshot()
	if (
		!isDeepStrictEqual(recovered, checkpoint) || snapshot.nextVersion !== submitted.nextVersion
		|| snapshot.processes.filter(item => item.actionName === 'stack.build').length
			!== submitted.processes.filter(item => item.actionName === 'stack.build').length
		|| !isDeepStrictEqual(snapshot.uploadGrants.find(item => item.appVersionId === checkpoint.appVersionId), receipt)
		|| snapshot.services.find(item => item.id === checkpoint.serviceId)?.activeAppVersionId !== checkpoint.appVersionId
	) {
		throw new Error('Recovery changed the submitted version, receipt, checkpoint, or build count')
	}
	return { runId, commitSha, checkpoint }
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
	return activeOperationsConfigSchema.parse(value)
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
	checkpoint: ManagedCheckpoint,
): Promise<void> => {
	const snapshot = await emulatorSnapshot()
	const services = snapshot.services.filter((service) => service.name === NOTES_DEPLOY_SERVICE)
	if (services.length !== 1) {
		throw new Error('Zerops emulator does not contain exactly one notes deploy service')
	}
	const serviceId = idResponseSchema.parse(services[0]).id
	confirmStagedManagedBinding(checkpoint, snapshot.serviceEnv.filter(record => record.serviceStackId === serviceId))
	const expected = new Map<ManagedKey, string>([
		[FABRIKA_OPERATIONS_DSN, config.dsn],
		[FABRIKA_APP_ID, NOTES_APP_ID],
		[FABRIKA_ENVIRONMENT, NOTES_ENVIRONMENT],
		[FABRIKA_SERVICE_KEY, DEFAULT_OPERATIONS_SERVICE_KEY],
		[FABRIKA_RELEASE, release],
	])
	for (const [key, expectedValue] of expected) {
		const binding = checkpoint.binding[key]
		if (binding.state !== 'confirmed') throw new Error(`Managed value ${key} has no confirmed version binding`)
		const backing = snapshot.serviceEnv.filter(record => record.serviceStackId === serviceId && record.id === binding.backingRecordId)
		if (
			serviceId !== checkpoint.serviceId || backing.length !== 1 || backing[0]?.key !== binding.referenceName
			|| backing[0]?.content !== expectedValue || backing[0]?.sensitive !== true
		) {
			throw new Error(`Zerops emulator managed value ${key} does not match the deploy projection`)
		}
	}
}

const proveIamAndNotes = async (provisioningKey: string): Promise<void> => {
	const schema = iamSchemaResponseSchema.parse(await requestJson(IAM_ORIGIN, '/admin/apps/notes/schema', { bearer: provisioningKey }))
	if (schema.actions.length !== 4 || schema.scopes.length !== 1) {
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
	const { apiKey, principalId } = keyPrincipalSchema.parse(keyResponse)
	try {
		const publicResponse = await requestJson(NOTES_ORIGIN, '/public/status')
		if (publicStatusSchema.parse(publicResponse).app !== 'notes') {
			throw new Error('public notes route returned the wrong app')
		}
		const title = `local smoke ${Date.now()}`
		const created = await requestJson(NOTES_ORIGIN, '/api/notes?workspace=local', {
			bearer: apiKey,
			body: { title },
		})
		if (createdNoteSchema.parse(created).note.title !== title) {
			throw new Error('authenticated note creation returned the wrong title')
		}
		const listed = await requestJson(NOTES_ORIGIN, '/api/notes?workspace=local', { bearer: apiKey })
		if (!notesListSchema.parse(listed).notes.some((note) => note.title === title)) {
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

/**
 * The public Operations hostname serves ingest and nothing else, and the refusal comes from the PROXY —
 * which is what makes it a boundary rather than a coincidence.
 *
 * `OPERATIONS_PROXY_GATES` declares two `public` rules and nothing else, so health, `/private/*`
 * reconciliation and the whole `/api/*` operator surface match no rule and are denied outright (403).
 * A valid machine credential buys nothing here either: it is not that the credential is wrong, it is
 * that the host declares no route to spend it on. Ingest passes its `public` gate and is then
 * challenged by Operations' own envelope credential check.
 */
const proveOperationsPublicBoundary = async (machineKey: string): Promise<void> => {
	const denied = ['/healthz', '/private/catalog/reconcile', '/private/releases/reconcile', '/api/undeclared-path', '/api/rpc']
	for (const path of denied) {
		const anonymous = await fetch(`${OPERATIONS_ORIGIN}${path}`, { redirect: 'manual' })
		if (anonymous.status !== 403) {
			throw new Error(`public Operations path ${path} returned ${anonymous.status}, expected a proxy refusal`)
		}
		const credentialed = await fetch(`${OPERATIONS_ORIGIN}${path}`, {
			redirect: 'manual',
			headers: { authorization: `Bearer ${machineKey}` },
		})
		if (credentialed.status !== 403) {
			throw new Error(`public Operations path ${path} admitted a machine credential with ${credentialed.status}`)
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

/** A navigation to the RPC URL must be redirected by the proxy before control handles the method. */
const proveControlIsGated = async (): Promise<void> => {
	const response = await fetch(`${CONTROL_ORIGIN}/api/rpc`, { headers: { accept: 'application/json' }, redirect: 'manual' })
	if (response.status !== 302) {
		throw new Error(`anonymous control /api/rpc returned ${response.status}, expected a proxy login redirect`)
	}
	const location = new URL(response.headers.get('location') ?? '')
	if (`${location.origin}${location.pathname}` !== `${IAM_ORIGIN}/auth/login`) {
		throw new Error('anonymous control /api/rpc was not sent to IAM')
	}
	if (location.searchParams.get('app') !== 'vozka' || location.searchParams.get('redirect') !== `${CONTROL_ORIGIN}/api/rpc`) {
		throw new Error('control login redirect does not name the app and the original URL')
	}
}

/**
 * Read the operator API the way the console does: through the proxy, through control's transport-only
 * gateway, with a real credential. It used to reach into the container and call `127.0.0.1:3000`
 * unauthenticated, which only worked while Operations synthesised a dev persona — a bypass that has
 * since been deleted from the SDK and never existed off-local.
 */
const operationsRpc = async (machineKey: string, method: string, input: unknown): Promise<unknown> => {
	const body = await requestJson(CONTROL_ORIGIN, '/operations/api/rpc', { bearer: machineKey, body: { method, input } })
	const parsed = rpcResponseSchema.safeParse(body)
	if (!parsed.success || parsed.data.result === undefined) {
		throw new Error(`Operations RPC ${method} was refused`)
	}
	return parsed.data.result
}

const matchingIssues = (value: unknown, marker: string) => issueListSchema.parse(value).items.filter((issue) => issue.title?.includes(marker))

const pollMarkerIssue = async (machineKey: string, marker: string, expectedCount: number) => {
	const issues = await poll(
		`Operations issue ${marker} count ${expectedCount}`,
		async () => matchingIssues(await operationsRpc(machineKey, 'issues', { query: marker, limit: 100 }), marker),
		(issues) => issues.length === 1 && issues[0]?.count === expectedCount,
	)
	const issue = issues[0]
	if (issue === undefined) throw new Error('Operations issue disappeared after polling')
	return issue
}

const eventId = (): string => randomUUID().replaceAll('-', '')

const sentryEvent = (input: {
	eventId: string
	marker: string
	release: string
}) => ({
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

const sentryEnvelope = (event: ReturnType<typeof sentryEvent>): string =>
	`${JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: 'event' })}\n${
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
	const rows = storageRowsSchema.safeParse(parseJson(output, 'Operations issue storage query'))
	if (!rows.success) throw new Error('Operations issue storage query returned an invalid result')
	const row = rows.data.find((candidate) => candidate.id === issueId)
	if (row === undefined) throw new Error('operator issue is missing from Operations storage')
	return storageIdentitySchema.parse(row)
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
	machineKey: string,
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

	const firstIssue = await pollMarkerIssue(machineKey, marker, 1)
	const issueId = idResponseSchema.parse(firstIssue).id
	const source = firstIssue.source
	if (
		source.appId !== NOTES_APP_ID
		|| source.environment !== NOTES_ENVIRONMENT
		|| source.serviceKey !== DEFAULT_OPERATIONS_SERVICE_KEY
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

	const repeatedIssue = await pollMarkerIssue(machineKey, marker, 2)
	if (idResponseSchema.parse(repeatedIssue).id !== issueId) {
		throw new Error('duplicate delivery changed the Operations issue identity')
	}
	await poll('the Operations ingest queue to drain', operationsQueueDepth, (depth) => depth === 0)
}

const main = async (): Promise<void> => {
	const fixtures = await loadLocalSourceFixtures(resolve(STATE_DIR, LOCAL_SOURCE_FIXTURE_DIRECTORY))
	const provisioningKey = envValue(resolve(STATE_DIR, 'iam.env'), 'FABRIKA_IAM_PROVISIONING_KEY')
	const machineKey = requireMachineKey()
	const webhookSecret = envValue(resolve(STATE_DIR, 'control.env'), 'GITHUB_WEBHOOK_SECRET')
	await requestJson(CONTROL_ORIGIN, '/healthz')
	await requestJson(IAM_ORIGIN, '/healthz')
	await requestJson(NOTES_ORIGIN, '/healthz')
	await proveOperationsPublicBoundary(machineKey)
	await proveControlIsGated()
	await ensureNamespace(machineKey)
	await proveNamespaceSource(machineKey, fixtures)
	await ensureNotesApp(machineKey, fixtures)
	const activeConfig = await activeOperationsConfig()
	await proveScopedWebhookSignature(webhookSecret, fixtures.application.commitSha)
	const deployment = await proveRestartReconciliation(machineKey, fixtures)
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
	await proveManagedOperationsEnvironment(deployedConfig, release, deployment.checkpoint)
	await proveOperationsIngestPersistence(machineKey, deployedConfig, release)
	await proveIamAndNotes(provisioningKey)
	await proveNamespaceIsolation()
	console.info(`Local stack smoke passed (run ${deployment.runId}); Notes behavior uses the separately composed container, not archive-built code`)
}

if (import.meta.main) {
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : 'local stack smoke failed')
		process.exit(1)
	})
}
