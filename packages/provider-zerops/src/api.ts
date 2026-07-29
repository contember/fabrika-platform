// The ZEROPS driver's collaborator: a thin, typed client over the Zerops REST API. This is the whole
// side-effect surface of a Zerops deploy — ADR-0003 says a deploy there is HTTP calls and nothing else, so
// substituting this ONE interface is what makes the driver testable and dry-run-able (ADR-0009).
//
// PROVENANCE. Every request/response shape below was read off Zerops' own OpenAPI document, served at
// `https://api.app-prg1.zerops.io/api/rest/public/swagger/openapi.yml` (linked from the REST API
// reference). Members whose shape could NOT be read off that document are marked `UNVERIFIED:` in their
// doc comment — there is exactly one such area (the log service behind `GET /project/{id}/log`), plus a
// handful of BEHAVIOURS (as opposed to shapes) that no document states. Do not quietly promote one to
// fact; check it against a real account first.
//
// SECURITY. The token is a Zerops PERSONAL ACCESS TOKEN and carries account-wide admin rights. It is
// never logged, never included in an error message, and never returned from a method.

/** Every status a Zerops application version can be in. VERIFIED: `OutDtoGetAppVersion.status` enum. */
export type ZeropsAppVersionStatus =
	| 'UPLOADING'
	| 'WAITING_TO_BUILD'
	| 'BUILDING'
	| 'BUILD_FAILED'
	| 'BUILD_VALIDATION_FAILED'
	| 'WAITING_TO_DEPLOY'
	| 'DEPLOYING'
	| 'DEPLOY_FAILED'
	| 'PREPARING_RUNTIME'
	| 'PREPARING_RUNTIME_FAILED'
	| 'ACTIVE'
	| 'BACKUP'
	| 'CANCELLED'

/** The one status that means "this version is live". */
export const ZEROPS_ACTIVE: ZeropsAppVersionStatus = 'ACTIVE'

/**
 * Statuses a version never leaves. `BACKUP` is included deliberately: a version we triggered that has
 * become an archived one was superseded by another deploy, which is an outcome, not a step on the way.
 */
export const ZEROPS_TERMINAL: ReadonlySet<ZeropsAppVersionStatus> = new Set<ZeropsAppVersionStatus>([
	'ACTIVE',
	'BACKUP',
	'BUILD_FAILED',
	'BUILD_VALIDATION_FAILED',
	'DEPLOY_FAILED',
	'PREPARING_RUNTIME_FAILED',
	'CANCELLED',
])

/** One application version, narrowed to what the driver reads. VERIFIED: `GET /app-version/{id}`. */
export interface ZeropsAppVersion {
	id: string
	/** Absent on a response that omitted it; the poll loop treats that as "not yet known". */
	status?: ZeropsAppVersionStatus
	serviceStackId?: string
	projectId?: string
	/** Monotonic per service — how Zerops orders the 10 versions it retains. */
	sequence?: number
	/** Build-pipeline timestamps (ISO dateTime), when a build ran. */
	build?: { startDate?: string; endDate?: string; pipelineStart?: string; pipelineFinish?: string; pipelineFailed?: string }
}

/** An asynchronous platform operation. VERIFIED: `OutDtoProcess`. */
export interface ZeropsProcess {
	id: string
	/** Free-form on the wire (`OutDtoProcess.status` is an untyped string defaulting to `PENDING`). */
	status?: string
	actionName?: string
	serviceStackId?: string
	appVersionId?: string
}

/** One service created or updated by an import. VERIFIED: `OutDtoProjectImportServiceStack`. */
export interface ZeropsImportedService {
	id: string
	/** The service's name as Zerops stores it (hostname, possibly suffixed by env). */
	name: string
	processes: ZeropsProcess[]
}

/** The result of applying an import document. VERIFIED: `ResponseProjectImport`. */
export interface ZeropsImportResult {
	projectId: string
	projectName?: string
	services: ZeropsImportedService[]
}

/** Every documented project lifecycle state. VERIFIED: `ResponseProject.status`. */
export type ZeropsProjectStatus = 'NEW' | 'CREATING' | 'ACTIVE' | 'DELETING' | 'FAILED' | 'STOPPING' | 'STOPPED' | 'STARTING'

/** Project compute tier. The import schema calls the same choice `corePackage`. VERIFIED: `ResponseProject.mode`. */
export type ZeropsProjectMode = 'LIGHT' | 'SERIOUS'

/** Every documented service-stack lifecycle state. VERIFIED: `ResponseServiceStack.status`. */
export type ZeropsServiceStatus =
	| 'NEW'
	| 'CREATING'
	| 'ACTIVE'
	| 'STOPPING'
	| 'STOPPED'
	| 'STARTING'
	| 'RESTARTING'
	| 'RELOADING'
	| 'DELETING'
	| 'DELETED'
	| 'FAILED'
	| 'ACTION_FAILED'
	| 'UPGRADING'
	| 'READY_TO_DEPLOY'
	| 'SERVICE_CREATING'
	| 'SERVICE_ACTIVE'
	| 'SERVICE_STOPPING'
	| 'SERVICE_STOPPED'
	| 'SERVICE_STARTING'
	| 'SERVICE_RESTARTING'
	| 'SERVICE_RELOADING'
	| 'SERVICE_DELETING'
	| 'SERVICE_DELETED'
	| 'SERVICE_FAILED'
	| 'SERVICE_ACTION_FAILED'
	| 'SERVICE_REPAIRING'
	| 'SERVICE_CONTAINER_FAILED'
	| 'SERVICE_MOVING_CONTAINER'
	| 'SERVICE_UPGRADING'
	| 'SERVICE_SCALING'
	| 'SERVICE_REPAIR_FAILED'
	| 'REPAIRING'
	| 'CONTAINER_FAILED'
	| 'MOVING_CONTAINER'
	| 'SCALING'
	| 'REPAIR_FAILED'

/** One service. VERIFIED: `ResponseServiceStack` (narrowed to the fields fabrika reads). */
export interface ZeropsService {
	id: string
	name: string
	projectId?: string
	status?: ZeropsServiceStatus
	/** Full service-type identifier, e.g. `alpine/bun@1.3`. VERIFIED: `ResponseServiceStack.base`. */
	base?: string
	activeAppVersionId?: string
	/** Whether Zerops' public subdomain routes this service. VERIFIED: `ResponseServiceStack.subdomainAccess`. */
	subdomainAccess?: boolean
	/** Provider profile identifier, e.g. `oltp-production`. VERIFIED: `ResponseServiceStack.autoscalingProfileId`. */
	autoscalingProfileId?: string
}

/** One project. VERIFIED: `ResponseProject` (narrowed). */
export interface ZeropsProject {
	id: string
	name: string
	status?: ZeropsProjectStatus
	/** The wire calls the import schema's `corePackage` choice `mode`. */
	mode?: ZeropsProjectMode
	/** VERIFIED: `ResponseProject.description`. */
	description?: string
	/** VERIFIED: `ResponseProject.tagList`. */
	tagList?: string[]
}

/**
 * ONE service-level environment variable. VERIFIED: `OutDtoUserData`.
 *
 * UNVERIFIED BEHAVIOUR: whether `content` carries the real value for a variable Zerops stores as a
 * SECRET, or a blurred placeholder. `docs/backlog/06-can-zerops-secrets-be-read-back.md` is open on
 * exactly this; the dashboard UX depends on the answer. Never log `content`.
 */
export interface ZeropsServiceEnv {
	id: string
	key: string
	content: string
	serviceStackId?: string
	/** `READ_ONLY` | `EDITABLE` | `SECRET` | `INTERNAL` | `ENV` — VERIFIED as an enum, meaning inferred. */
	type?: string
}

/**
 * A short-lived grant for the project's LOG service. VERIFIED: `ResponseProjectLog` — the field names and
 * types are exactly these. What is NOT verified is what the URLs speak; see `readBuildLog`.
 */
export interface ZeropsLogAccess {
	url: string
	urlPlain: string
	urlInfo: string
	urlUi: string
	/** Bearer for the log service (a different credential from the personal access token). Never log it. */
	accessToken: string
	/** ISO dateTime after which the grant is dead and must be re-fetched. */
	expiration: string
}

/** One relayed build/runtime log line. Shape is fabrika's, not the platform's. */
export interface ZeropsLogLine {
	/** ISO timestamp when Zerops recorded the line, when it supplied one. */
	timestamp?: string
	message: string
}

/**
 * The Zerops REST surface fabrika depends on, as ONE injectable interface (ADR-0009's collaborator
 * bundle). Every method takes the run's `AbortSignal`: a driver that polls `/app-version` is precisely the
 * case cancellation was added for, and an abandoned run must not keep an HTTP request alive.
 *
 * WIDER THAN THE DRIVER, on purpose. The driver uses four of these; the rest are the CONTROL PLANE's
 * Zerops surface — `putServiceEnv`/`listServiceEnv` for the edit-time secret writes that ADR-0004 says are
 * not a deploy step, `importProject` for creating a managed project, and `getAppVersion`/`latestAppVersion`
 * for the startup reconciliation of in-flight runs that ADR-0003 makes a requirement. One client, so there
 * is one place the Zerops contract is written down.
 *
 * NOTE WHAT IS ABSENT. There is no method that writes a PROJECT-level environment variable. That is not
 * an oversight and must not be "completed": project-level variables are injected into every service in the
 * project, and one project holds many apps, so a project-level write hands app A's credentials to app B
 * (ADR-0004). The invariant is enforced by the surface not existing — `POST /project/{id}/env` and
 * `PUT /project-env/{id}` are real endpoints that this client deliberately does not expose. `getProjectEnv`
 * reads one back (for drift reporting); nothing here can create or change one.
 */
export interface ZeropsApi {
	// ── service-stack: applying the compiled import document ──────────────────────

	/**
	 * Apply a `zerops-import.yaml` (its `services:` section) to an EXISTING project — fabrika's
	 * provisioning step. VERIFIED: `POST /project/{id}/service-stack/import`, body `{ yaml }`.
	 *
	 * UNVERIFIED BEHAVIOUR: that re-applying an unchanged document with `override: true` is a no-op rather
	 * than a redeploy. `override` is documented only as "Override existing service"; the whole
	 * idempotency claim in ADR-0003 rests on it and should be confirmed against a real account.
	 */
	importServices(input: { projectId: string; yaml: string; signal: AbortSignal }): Promise<ZeropsImportResult>

	/**
	 * Apply a full `zerops-import.yaml` INCLUDING its `project:` section, creating the project.
	 * VERIFIED: `POST /client/{id}/project/import`, body `{ yaml }`.
	 *
	 * Needed because `envIsolation` is settable at project CREATION only — `RequestPutProject` has no such
	 * field, so a project made without it cannot be corrected through the project API afterwards. The
	 * driver compensates by also setting `envIsolation` per service, which the schema says overrides the
	 * project-level value.
	 */
	importProject(input: { clientId: string; yaml: string; signal: AbortSignal }): Promise<ZeropsImportResult>

	// ── app-version: build + deploy ───────────────────────────────────────────────

	/**
	 * Trigger a build+deploy pipeline for a service. VERIFIED:
	 * `PUT /service-stack/{id}/trigger-pipeline`, body `RequestPutStandardServiceStackTriggerPipeline`.
	 *
	 * With no `buildFromGit` the platform builds from the service's configured Git integration (the
	 * private-repo path); with one it does a one-time build from that PUBLIC repository URL.
	 *
	 * UNVERIFIED BEHAVIOUR: the response is `{ process?: … }` with EVERY field optional, so whether the
	 * new app-version id is reliably reachable at `process.appVersion.id` is a guess. The driver therefore
	 * does not depend on it — it resolves the version it triggered via `latestAppVersion` instead.
	 */
	triggerPipeline(input: {
		serviceId: string
		/** Public Git repository URL for a one-time build. Omit to use the service's Git integration. */
		buildFromGit?: string
		/** Inline `zerops.yaml`, overriding whatever is in the repo. */
		zeropsYaml?: string
		/** Which `setup:` block of the `zerops.yaml` to use. */
		zeropsSetup?: string
		signal: AbortSignal
	}): Promise<ZeropsProcess | null>

	/** One application version's current state — the poll target. VERIFIED: `GET /app-version/{id}`. */
	getAppVersion(input: { appVersionId: string; signal: AbortSignal }): Promise<ZeropsAppVersion>

	/**
	 * The newest application version of a service. VERIFIED: `GET /service-stack/{id}/app-version`
	 * (`{ list, totalCount }`, `limit`/`offset`/`statuses` query params).
	 *
	 * UNVERIFIED BEHAVIOUR: the list's ORDER. The driver does not rely on it — it picks the highest
	 * `sequence`, which the schema documents as monotonic per service.
	 */
	latestAppVersion(input: { serviceId: string; signal: AbortSignal }): Promise<ZeropsAppVersion | null>

	/** Cancel an in-flight build — what a cancelled run does with the work it started. VERIFIED: `PUT /app-version/{id}/cancel-build`. */
	cancelBuild(input: { appVersionId: string; signal: AbortSignal }): Promise<void>

	// ── service-stack / project: reading state ────────────────────────────────────

	/** One service by id. VERIFIED: `GET /service-stack/{id}`. */
	getService(input: { serviceId: string; signal: AbortSignal }): Promise<ZeropsService>

	/** One service by hostname within a project, or `null` if absent. VERIFIED: `GET /service-stack-by-name/{projectId}/{name}`. */
	findService(input: { projectId: string; hostname: string; signal: AbortSignal }): Promise<ZeropsService | null>

	/** One project by id. VERIFIED: `GET /project/{id}`. */
	getProject(input: { projectId: string; signal: AbortSignal }): Promise<ZeropsProject>

	/**
	 * Every project under a client. VERIFIED: `GET /client/{id}/project`.
	 * The implementation follows the response's `totalCount` with explicit `limit`/`offset` pages.
	 */
	listProjects(input: { clientId: string; signal: AbortSignal }): Promise<ZeropsProject[]>

	/**
	 * Every exact-name match under a client. VERIFIED: `GET /client/{id}/projects-by-name/{name}`.
	 * Zerops returns an array, so duplicate names remain visible to the caller.
	 */
	findProjects(input: { clientId: string; name: string; signal: AbortSignal }): Promise<ZeropsProject[]>

	/**
	 * Every service stack under a project. VERIFIED: `GET /project/{id}/service-stack`.
	 * The implementation follows the response's `totalCount` with explicit `limit`/`offset` pages.
	 */
	listProjectServices(input: { projectId: string; signal: AbortSignal }): Promise<ZeropsService[]>

	// ── user-data: SERVICE-level environment variables (ADR-0004) ─────────────────

	/** Every environment variable of ONE service. VERIFIED: `GET /service-stack/{id}/user-data`. */
	listServiceEnv(input: { serviceId: string; signal: AbortSignal }): Promise<ZeropsServiceEnv[]>

	/**
	 * Create-or-update ONE service-level variable — the only way fabrika ever writes a secret, and it is
	 * addressed BY SERVICE so ADR-0004's invariant cannot be violated by calling it.
	 * VERIFIED: `POST /service-stack/{id}/user-data` and `PUT /user-data/{id}`, both `{ key, content }`.
	 *
	 * UNVERIFIED BEHAVIOUR: whether POSTing an existing key replaces it or conflicts. The default
	 * implementation therefore lists first and chooses POST or PUT, which is correct under either answer.
	 */
	putServiceEnv(input: { serviceId: string; key: string; value: string; signal: AbortSignal }): Promise<void>

	/** Delete one service-level variable by its record id. VERIFIED: `DELETE /user-data/{id}`. */
	deleteServiceEnv(input: { envId: string; signal: AbortSignal }): Promise<void>

	/**
	 * Read ONE project-level variable back, by record id. VERIFIED: `GET /project-env/{id}`.
	 * Read-only ON PURPOSE — see the note on this interface. Present so drift can be REPORTED.
	 */
	getProjectEnv(input: { projectEnvId: string; signal: AbortSignal }): Promise<ZeropsServiceEnv>

	// ── logs ──────────────────────────────────────────────────────────────────────

	/** A short-lived grant for the project's log service. VERIFIED: `GET /project/{id}/log`. */
	getLogAccess(input: { projectId: string; signal: AbortSignal }): Promise<ZeropsLogAccess>

	/**
	 * UNVERIFIED — THE ONE SHAPE NOBODY COULD CHECK. `GET /project/{id}/log` hands back URLs to a
	 * SEPARATE log service, and that service's request/response contract appears in no published document
	 * (it is not in the OpenAPI file, which stops at the grant). The default implementation's reading is:
	 * GET `urlPlain` with the grant as a bearer, one plain-text line per log record, `limit`/`from` as
	 * query params. Treat that as a guess.
	 *
	 * BECAUSE it is a guess, the driver treats a failure here as non-fatal: log relay degrades to "no
	 * lines" and the deploy still succeeds or fails on `/app-version` status alone. An unverified endpoint
	 * must never be able to fail a deploy.
	 */
	readBuildLog(input: { access: ZeropsLogAccess; serviceId: string; limit?: number; signal: AbortSignal }): Promise<ZeropsLogLine[]>
}

// ── default (real) implementation ───────────────────────────────────────────────

/** Base URL of the Zerops public REST API. */
export const ZEROPS_API_BASE = 'https://api.app-prg1.zerops.io/api/rest/public'

/**
 * Just enough of `fetch` for this client — narrower than `typeof fetch` so a test can supply a plain
 * function without also implementing the runtime's extras (`preconnect`).
 */
export type FetchLike = (
	input: string,
	init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>

/** How the real client is built. `fetchImpl` exists so a test can drive the REAL client offline. */
export interface ZeropsApiOptions {
	/** Zerops personal access token. Sent as `Authorization: Bearer`. NEVER logged. */
	token: string
	/** Override for a different region's API host. */
	baseUrl?: string
	fetchImpl?: FetchLike
}

/** Read a property off an unknown value without asserting anything about the value's shape. */
const prop = (
	value: unknown,
	key: string,
): unknown => (typeof value === 'object' && value !== null && key in value ? Reflect.get(value, key) : undefined)

const str = (value: unknown, key: string): string | undefined => {
	const found = prop(value, key)
	return typeof found === 'string' ? found : undefined
}

const num = (value: unknown, key: string): number | undefined => {
	const found = prop(value, key)
	return typeof found === 'number' ? found : undefined
}

const bool = (value: unknown, key: string): boolean | undefined => {
	const found = prop(value, key)
	return typeof found === 'boolean' ? found : undefined
}

const arr = (value: unknown, key: string): unknown[] => {
	const found = prop(value, key)
	return Array.isArray(found) ? found : []
}

const stringList = (value: unknown, key: string): string[] | undefined => {
	const found = prop(value, key)
	if (!Array.isArray(found) || found.some((entry) => typeof entry !== 'string')) {
		return undefined
	}
	return found.filter((entry): entry is string => typeof entry === 'string')
}

/** Every valid `ZeropsAppVersionStatus`, in pipeline order. The array's element type keeps it exhaustive. */
const STATUSES: readonly ZeropsAppVersionStatus[] = [
	'UPLOADING',
	'WAITING_TO_BUILD',
	'BUILDING',
	'BUILD_FAILED',
	'BUILD_VALIDATION_FAILED',
	'WAITING_TO_DEPLOY',
	'DEPLOYING',
	'DEPLOY_FAILED',
	'PREPARING_RUNTIME',
	'PREPARING_RUNTIME_FAILED',
	'ACTIVE',
	'BACKUP',
	'CANCELLED',
]

const PROJECT_STATUSES: readonly ZeropsProjectStatus[] = [
	'NEW',
	'CREATING',
	'ACTIVE',
	'DELETING',
	'FAILED',
	'STOPPING',
	'STOPPED',
	'STARTING',
]

const PROJECT_MODES: readonly ZeropsProjectMode[] = ['LIGHT', 'SERIOUS']

const SERVICE_STATUSES: readonly ZeropsServiceStatus[] = [
	'NEW',
	'CREATING',
	'ACTIVE',
	'STOPPING',
	'STOPPED',
	'STARTING',
	'RESTARTING',
	'RELOADING',
	'DELETING',
	'DELETED',
	'FAILED',
	'ACTION_FAILED',
	'UPGRADING',
	'READY_TO_DEPLOY',
	'SERVICE_CREATING',
	'SERVICE_ACTIVE',
	'SERVICE_STOPPING',
	'SERVICE_STOPPED',
	'SERVICE_STARTING',
	'SERVICE_RESTARTING',
	'SERVICE_RELOADING',
	'SERVICE_DELETING',
	'SERVICE_DELETED',
	'SERVICE_FAILED',
	'SERVICE_ACTION_FAILED',
	'SERVICE_REPAIRING',
	'SERVICE_CONTAINER_FAILED',
	'SERVICE_MOVING_CONTAINER',
	'SERVICE_UPGRADING',
	'SERVICE_SCALING',
	'SERVICE_REPAIR_FAILED',
	'REPAIRING',
	'CONTAINER_FAILED',
	'MOVING_CONTAINER',
	'SCALING',
	'REPAIR_FAILED',
]

/**
 * Narrow a wire string to a known status. `undefined` means Zerops sent something this build does not
 * know — which the poll loop must treat as "keep waiting", never as success or failure.
 */
export const asAppVersionStatus = (value: unknown): ZeropsAppVersionStatus | undefined => STATUSES.find((status) => status === value)

const asProjectStatus = (value: unknown): ZeropsProjectStatus | undefined => PROJECT_STATUSES.find((status) => status === value)

const asProjectMode = (value: unknown): ZeropsProjectMode | undefined => PROJECT_MODES.find((mode) => mode === value)

const asServiceStatus = (value: unknown): ZeropsServiceStatus | undefined => SERVICE_STATUSES.find((status) => status === value)

const readAppVersion = (value: unknown): ZeropsAppVersion => ({
	id: str(value, 'id') ?? '',
	status: asAppVersionStatus(prop(value, 'status')),
	serviceStackId: str(value, 'serviceStackId'),
	projectId: str(value, 'projectId'),
	sequence: num(value, 'sequence'),
	build: typeof prop(value, 'build') === 'object' && prop(value, 'build') !== null
		? {
			startDate: str(prop(value, 'build'), 'startDate'),
			endDate: str(prop(value, 'build'), 'endDate'),
			pipelineStart: str(prop(value, 'build'), 'pipelineStart'),
			pipelineFinish: str(prop(value, 'build'), 'pipelineFinish'),
			pipelineFailed: str(prop(value, 'build'), 'pipelineFailed'),
		}
		: undefined,
})

const readProcess = (value: unknown): ZeropsProcess => ({
	id: str(value, 'id') ?? '',
	status: str(value, 'status'),
	actionName: str(value, 'actionName'),
	serviceStackId: str(value, 'serviceStackId'),
	appVersionId: str(prop(value, 'appVersion'), 'id'),
})

const readService = (value: unknown): ZeropsService => ({
	id: str(value, 'id') ?? '',
	name: str(value, 'name') ?? '',
	projectId: str(value, 'projectId'),
	status: asServiceStatus(prop(value, 'status')),
	base: str(value, 'base'),
	activeAppVersionId: str(prop(value, 'activeAppVersion'), 'id'),
	...(bool(value, 'subdomainAccess') !== undefined ? { subdomainAccess: bool(value, 'subdomainAccess') } : {}),
	...(str(value, 'autoscalingProfileId') !== undefined ? { autoscalingProfileId: str(value, 'autoscalingProfileId') } : {}),
})

const readProject = (value: unknown): ZeropsProject => ({
	id: str(value, 'id') ?? '',
	name: str(value, 'name') ?? '',
	status: asProjectStatus(prop(value, 'status')),
	mode: asProjectMode(prop(value, 'mode')),
	...(str(value, 'description') !== undefined ? { description: str(value, 'description') } : {}),
	...(stringList(value, 'tagList') !== undefined ? { tagList: stringList(value, 'tagList') } : {}),
})

const readServiceEnv = (value: unknown): ZeropsServiceEnv => ({
	id: str(value, 'id') ?? '',
	key: str(value, 'key') ?? '',
	content: str(value, 'content') ?? '',
	serviceStackId: str(value, 'serviceStackId'),
	type: str(value, 'type'),
})

/**
 * Turn a non-2xx response into an Error. Zerops answers with `{ error: { code, message, meta } }` (the
 * envelope observed live; the OpenAPI `Error` schema shows the inner `{ code, message }`). The message is
 * short and never echoes the request body, which could hold a secret value.
 */
const apiError = (label: string, status: number, body: unknown): Error => {
	const message = str(prop(body, 'error'), 'message') ?? str(body, 'message') ?? ''
	const code = str(prop(body, 'error'), 'code') ?? str(body, 'code') ?? ''
	const detail = [code, message].filter((part) => part !== '').join(': ')
	return new Error(`zerops: ${label} failed (${status})${detail === '' ? '' : ` — ${detail.slice(0, 300)}`}`)
}

/** Build the real client. Every request carries the bearer and the run's signal. */
export const createZeropsApi = (options: ZeropsApiOptions): ZeropsApi => {
	const base = (options.baseUrl ?? ZEROPS_API_BASE).replace(/\/+$/, '')
	const doFetch = options.fetchImpl ?? fetch

	const request = async (
		label: string,
		method: string,
		path: string,
		/**
		 * `redactDetail` drops the server's message from the thrown error. Set it on any call whose BODY
		 * carries a secret value: a validation error can quote what it rejected, and an error that echoes a
		 * secret into a deploy log is a leak whichever end wrote it.
		 */
		init: { body?: unknown; signal: AbortSignal; redactDetail?: boolean },
	): Promise<unknown> => {
		const headers: Record<string, string> = { authorization: `Bearer ${options.token}`, accept: 'application/json' }
		if (init.body !== undefined) {
			headers['content-type'] = 'application/json'
		}
		const response = await doFetch(`${base}${path}`, {
			method,
			headers,
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
			signal: init.signal,
		})
		const payload: unknown = await response.json().catch(() => null)
		if (!response.ok) {
			throw apiError(label, response.status, init.redactDetail === true ? null : payload)
		}
		return payload
	}

	const readImportResult = (payload: unknown): ZeropsImportResult => ({
		projectId: str(payload, 'projectId') ?? '',
		projectName: str(payload, 'projectName'),
		services: arr(payload, 'serviceStacks').map((entry) => ({
			id: str(entry, 'id') ?? '',
			name: str(entry, 'name') ?? '',
			processes: arr(entry, 'processes').map(readProcess),
		})),
	})

	const PAGE_SIZE = 100
	const readAllPages = async <Item>(
		label: string,
		path: string,
		signal: AbortSignal,
		readItem: (value: unknown) => Item,
	): Promise<Item[]> => {
		const items: Item[] = []
		let offset = 0
		while (true) {
			const separator = path.includes('?') ? '&' : '?'
			const payload = await request(label, 'GET', `${path}${separator}limit=${PAGE_SIZE}&offset=${offset}`, { signal })
			const page = arr(payload, 'list')
			const totalCount = num(payload, 'totalCount')
			if (totalCount === undefined || !Number.isInteger(totalCount) || totalCount < 0) {
				throw new Error(`zerops: ${label} returned an invalid totalCount`)
			}
			items.push(...page.map(readItem))
			if (items.length >= totalCount) {
				return items
			}
			if (page.length === 0) {
				throw new Error(`zerops: ${label} ended before totalCount`)
			}
			offset += page.length
		}
	}

	return {
		importServices: async ({ projectId, yaml, signal }) =>
			readImportResult(await request('service-stack import', 'POST', `/project/${projectId}/service-stack/import`, { body: { yaml }, signal })),

		importProject: async ({ clientId, yaml, signal }) =>
			readImportResult(await request('project import', 'POST', `/client/${clientId}/project/import`, { body: { yaml }, signal })),

		triggerPipeline: async ({ serviceId, buildFromGit, zeropsYaml, zeropsSetup, signal }) => {
			const body: Record<string, unknown> = {}
			if (buildFromGit !== undefined) {
				body['buildFromGit'] = buildFromGit
			}
			if (zeropsYaml !== undefined) {
				body['zeropsYaml'] = zeropsYaml
			}
			if (zeropsSetup !== undefined) {
				body['zeropsSetup'] = zeropsSetup
			}
			const payload = await request('trigger-pipeline', 'PUT', `/service-stack/${serviceId}/trigger-pipeline`, { body, signal })
			const process = prop(payload, 'process')
			return process === undefined || process === null ? null : readProcess(process)
		},

		getAppVersion: async ({ appVersionId, signal }) =>
			readAppVersion(await request('get app-version', 'GET', `/app-version/${appVersionId}`, { signal })),

		latestAppVersion: async ({ serviceId, signal }) => {
			const payload = await request('list app-versions', 'GET', `/service-stack/${serviceId}/app-version?limit=25`, { signal })
			const versions = arr(payload, 'list').map(readAppVersion)
			// Highest `sequence` wins — the list's order is not documented, the sequence's meaning is.
			return versions.reduce<ZeropsAppVersion | null>(
				(best, version) => (best === null || (version.sequence ?? -1) > (best.sequence ?? -1) ? version : best),
				null,
			)
		},

		cancelBuild: async ({ appVersionId, signal }) => {
			await request('cancel-build', 'PUT', `/app-version/${appVersionId}/cancel-build`, { signal })
		},

		getService: async ({ serviceId, signal }) => readService(await request('get service', 'GET', `/service-stack/${serviceId}`, { signal })),

		findService: async ({ projectId, hostname, signal }) => {
			try {
				return readService(await request('find service', 'GET', `/service-stack-by-name/${projectId}/${encodeURIComponent(hostname)}`, { signal }))
			} catch (error) {
				// A missing service is an answer, not a failure; anything else propagates.
				if (error instanceof Error && error.message.includes('(404)')) {
					return null
				}
				throw error
			}
		},

		getProject: async ({ projectId, signal }) => {
			const payload = await request('get project', 'GET', `/project/${projectId}`, { signal })
			return readProject(payload)
		},

		listProjects: async ({ clientId, signal }) => readAllPages('list projects', `/client/${clientId}/project`, signal, readProject),

		findProjects: async ({ clientId, name, signal }) => {
			const payload = await request(
				'find projects',
				'GET',
				`/client/${clientId}/projects-by-name/${encodeURIComponent(name)}`,
				{ signal },
			)
			return arr(payload, 'projects').map(readProject)
		},

		listProjectServices: async ({ projectId, signal }) =>
			readAllPages('list project services', `/project/${projectId}/service-stack`, signal, readService),

		listServiceEnv: async ({ serviceId, signal }) => {
			const payload = await request('list service env', 'GET', `/service-stack/${serviceId}/user-data`, { signal })
			return arr(payload, 'list').map(readServiceEnv)
		},

		putServiceEnv: async ({ serviceId, key, value, signal }) => {
			const listed = await request('list service env', 'GET', `/service-stack/${serviceId}/user-data`, { signal })
			const existing = arr(listed, 'list').map(readServiceEnv).find((entry) => entry.key === key)
			// `redactDetail` on both writes: this is the one place a secret VALUE is in the request body.
			if (existing === undefined) {
				await request('create service env', 'POST', `/service-stack/${serviceId}/user-data`, {
					body: { key, content: value },
					signal,
					redactDetail: true,
				})
				return
			}
			await request('update service env', 'PUT', `/user-data/${existing.id}`, { body: { key, content: value }, signal, redactDetail: true })
		},

		deleteServiceEnv: async ({ envId, signal }) => {
			await request('delete service env', 'DELETE', `/user-data/${envId}`, { signal })
		},

		getProjectEnv: async ({ projectEnvId, signal }) =>
			readServiceEnv(await request('get project env', 'GET', `/project-env/${projectEnvId}`, { signal })),

		getLogAccess: async ({ projectId, signal }) => {
			const payload = await request('get log access', 'GET', `/project/${projectId}/log`, { signal })
			return {
				url: str(payload, 'url') ?? '',
				urlPlain: str(payload, 'urlPlain') ?? '',
				urlInfo: str(payload, 'urlInfo') ?? '',
				urlUi: str(payload, 'urlUi') ?? '',
				accessToken: str(payload, 'accessToken') ?? '',
				expiration: str(payload, 'expiration') ?? '',
			}
		},

		readBuildLog: async ({ access, serviceId, limit, signal }) => {
			// UNVERIFIED (see the interface): this is a best reading of an undocumented log service, not a
			// contract. It is written so a wrong guess degrades to "no lines" instead of failing a deploy.
			if (access.urlPlain === '') {
				return []
			}
			const separator = access.urlPlain.includes('?') ? '&' : '?'
			const url = `${access.urlPlain}${separator}serviceStackId=${encodeURIComponent(serviceId)}&limit=${limit ?? 200}`
			const response = await doFetch(url, { headers: { authorization: `Bearer ${access.accessToken}` }, signal })
			if (!response.ok) {
				throw new Error(`zerops: read build log failed (${response.status})`)
			}
			const text = await response.text()
			return text.split('\n').filter((line) => line.trim() !== '').map((line) => ({ message: line }))
		},
	}
}
