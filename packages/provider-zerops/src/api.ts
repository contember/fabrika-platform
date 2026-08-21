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
// never logged, never included in an error message, and never returned from a method. There is exactly
// one credential this module DOES hand back — the integration token `createIntegrationToken` mints, which
// exists so that nothing has to reuse the personal one; it obeys the same no-log, no-error-message rule.

import type { Sleeper } from './collaborators'

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

/**
 * `sensitive` on every user-data WRITE, create and update alike. Required by the platform — omitting it answers
 * `400 invalidUserInput` with `{"sensitive":["field is required"]}` (measured live, 2026-08-18) — and
 * `true` because most of what fabrika writes is a credential. It costs nothing to read: a sensitive
 * variable's `content` still comes back verbatim from `GET /service-stack/{id}/env`, also measured, so the
 * compare-before-write both `platform deploy` and the create-only credential slots depend on still works.
 */
const SENSITIVE_USER_DATA = true

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

/** The credential-bearing result of reserving one upload-backed application version. */
export interface ZeropsAppVersionUpload {
	id: string
	/** Presigned object-storage destination. Never log it or include it in an error. */
	uploadUrl: string
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

/**
 * The status a process that succeeded carries.
 *
 * VERIFIED AS A VALUE, not as an enum member: `docs/reference/zerops-platform.md` records
 * `stack.updateUserData`, `stack.enableSubdomainAccess` and an import's processes reaching exactly this
 * string live. `ResponseProcess.status` is an untyped string in the published document, so the platform
 * declares no set anywhere.
 */
export const ZEROPS_PROCESS_FINISHED = 'FINISHED'

/**
 * Statuses a process never leaves.
 *
 * UNVERIFIED AS A CLOSED SET — the OpenAPI document gives `ResponseProcess.status` no enum at all. These
 * are the values `zops process list --status` documents (`PENDING, RUNNING, FINISHED, FAILED, CANCELED`)
 * minus the two that mean "still going". Note the single `L` in `CANCELED`: an app VERSION spells the same
 * idea `CANCELLED`, and the two vocabularies are not the same one.
 *
 * `waitForProcess` treats everything not in here as "keep waiting", so a status this build has never seen
 * can only ever cost time — it can never be read as success.
 */
export const ZEROPS_PROCESS_TERMINAL: ReadonlySet<string> = new Set(['FINISHED', 'FAILED', 'CANCELED'])

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
 * A Zerops access role. VERIFIED: the `roleCode` enum, shared by `RequestClientIntegrationToken` and
 * `ResponseClientIntegrationTokenRaw`.
 *
 * Tiered, and the schema's own description states the order: `OWNER > ADMIN > BASIC_USER > READ_ONLY >
 * NO_ACCESS`, with a PROJECT role overriding the client-wide one. That override is the whole mechanism
 * behind a scoped token — client `NO_ACCESS` plus one project `ADMIN` reaches exactly one project.
 */
export type ZeropsRoleCode = 'OWNER' | 'ADMIN' | 'BASIC_USER' | 'READ_ONLY' | 'NO_ACCESS'

/**
 * One project grant carried by an integration token. VERIFIED:
 * `ResponseClientIntegrationTokenRaw.projects[]` — `projectId` is required and `roleCode` is not, so a
 * grant read back can omit it (the schema documents `NO_ACCESS` as the default; this client does not
 * substitute one, because an assumed grant is worse than an absent one).
 */
export interface ZeropsTokenProjectGrant {
	projectId: string
	roleCode?: ZeropsRoleCode
}

/**
 * A freshly minted integration token. VERIFIED: `ResponseClientIntegrationTokenRaw` — `id`, `name`,
 * `projects` and `token` are all in its `required` list.
 *
 * THE ONE SHAPE ON THIS CLIENT THAT CARRIES A CREDENTIAL, and the `Raw` in the schema's name is why: the
 * plaintext `token` appears in this one response and nowhere afterwards. Everything the module header says
 * about the personal access token applies to it — never logged, never in an error message — with the
 * single exception that it must reach whatever is going to store it.
 */
export interface ZeropsIntegrationToken {
	id: string
	name: string
	/** The bearer value. NEVER log it. */
	token: string
	/** The grants the platform actually recorded, so a caller can check the scope it asked for. */
	projects: ZeropsTokenProjectGrant[]
	/** The client-wide role. Absent from the response's `required` list, so it can genuinely be missing. */
	roleCode?: ZeropsRoleCode
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
 * Zerops surface — the service-env methods for the edit-time secret writes that ADR-0004 says are not a
 * deploy step, `importProject` for creating a managed project, and `getAppVersion`/`latestAppVersion` for
 * the startup reconciliation of in-flight runs that ADR-0003 makes a requirement. One client, so there is
 * one place the Zerops contract is written down.
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
	 * VERIFIED (2026-08-05): re-applying an unchanged document is a complete no-op — same ids, no
	 * processes, `lastUpdate` unmoved. That is ADR-0003's idempotency claim, and it is ALL of it: a
	 * changed `profile`/`maxContainers`/`objectStorageSize` is silently ignored too, so this reconciles
	 * nothing. Change a live field through the API that owns it.
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

	/**
	 * Reserve an upload-backed application version. VERIFIED: `POST /service-stack/{id}/app-version`,
	 * optional body `{ name }`, response `ResponsePostAppVersion`.
	 */
	createAppVersion(input: { serviceId: string; name?: string; signal: AbortSignal }): Promise<ZeropsAppVersionUpload>

	/**
	 * Build and deploy an application version whose source archive has already been uploaded. VERIFIED:
	 * `PUT /app-version/{id}/build-and-deploy`, required body `{ zeropsYaml }` and optional
	 * `zeropsYamlSetup`.
	 */
	buildAndDeployAppVersion(input: {
		appVersionId: string
		zeropsYaml: string
		zeropsYamlSetup?: string
		signal: AbortSignal
	}): Promise<ZeropsProcess>

	/** Delete an application version, including an untriggered upload reservation. VERIFIED: `DELETE /app-version/{id}`. */
	deleteAppVersion(input: { appVersionId: string; signal: AbortSignal }): Promise<void>

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

	// ── process: the asynchronous half of almost every write ──────────────────────

	/**
	 * One platform operation's current state. VERIFIED: `GET /process/{id}` (`GetProcessDetails`,
	 * response `ResponseProcess`).
	 *
	 * WHAT IT IS FOR. Several writes here return a process INSTEAD of their result and complete afterwards:
	 * an import hands back one per service it touched, and `POST /service-stack/{id}/user-data` answers with
	 * a process rather than the record it created. A caller that imports services and then immediately
	 * writes their environment needs to know the import's processes finished, and until this existed
	 * nothing could ask.
	 *
	 * UNVERIFIED BEHAVIOUR: the status VOCABULARY (see `ZEROPS_PROCESS_TERMINAL`). The published document
	 * types `status` as a bare string defaulting to `PENDING`, so it stays `string` here rather than being
	 * narrowed to a set nobody publishes.
	 */
	getProcess(input: { processId: string; signal: AbortSignal }): Promise<ZeropsProcess>

	// ── service-stack: public access ──────────────────────────────────────────────

	/**
	 * Publish a service on Zerops' generated `*.zerops.app` subdomain. VERIFIED:
	 * `PUT /service-stack/{id}/enable-subdomain-access`, no body, `ResponseProcess`.
	 *
	 * THE ONLY THING THAT ESTABLISHES ONE. `enableSubdomainAccess: true` in an import document is accepted
	 * and then silently dropped — on CREATE as well as on `override` — so a service imported with it reads
	 * back `subdomainAccess: false` and stays that way (`docs/reference/zerops-platform.md`).
	 *
	 * TWO ORDERING FACTS the caller must respect. It needs a DEPLOYED HTTP port: before the first deploy
	 * the platform answers `400 serviceStackIsNotHttp`. And a 2xx here is NOT a success signal — calling it
	 * on a service that already has a subdomain returns a process that then FAILS — so decide by reading
	 * `getService().subdomainAccess` back, never by this call returning.
	 */
	enableSubdomainAccess(input: { serviceId: string; signal: AbortSignal }): Promise<void>

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
	//
	// EVERY WRITE HERE IS ASYNCHRONOUS. Create, replace and delete each answer with a PENDING
	// `stack.updateUserData` process rather than the record, and while one is running the platform
	// refuses the next operation on that service with `400 userDataSyncRunning`. So all three wait for
	// their own process before returning: a caller that writes a variable and then builds — which is
	// what every deploy does — must not have to know that.

	/**
	 * Every environment variable of ONE service, each with the record id `deleteServiceEnv` takes.
	 * VERIFIED: `GET /service-stack/{id}/env` (`{ items }`).
	 *
	 * NOT `GET /service-stack/{id}/user-data`, which answers `400 serviceStackNotFound` on every
	 * service, deployed or not — see `docs/reference/zerops-platform.md`. The `/env` reading omits
	 * variables the service's own `zerops.yaml` declares (`type: ENV`); fabrika never writes those.
	 * The OpenAPI publishes no lookup/pagination terms and live probes found query terms ignored, so the
	 * implementation reads one full response under a byte bound rather than imposing an entry-count cap.
	 */
	listServiceEnv(input: { serviceId: string; signal: AbortSignal }): Promise<ZeropsServiceEnv[]>

	/**
	 * Create ONE service-level variable only when the key is absent.
	 * VERIFIED: `POST /service-stack/{id}/user-data`, body `{ key, content }`.
	 *
	 * Unlike `putServiceEnv`, a duplicate is an error and is never followed by a read or update. Error
	 * details are intentionally unavailable because both the request and an upstream response can contain
	 * the secret value.
	 */
	createServiceEnv(input: { serviceId: string; key: string; value: string; signal: AbortSignal }): Promise<void>

	/**
	 * Create-or-update ONE service-level variable — the only way fabrika ever writes a secret, and it is
	 * addressed BY SERVICE so ADR-0004's invariant cannot be violated by calling it.
	 * VERIFIED: `POST /service-stack/{id}/user-data` creates and `PUT /user-data/{id}` replaces, both
	 * `{ key, content }`; POSTing an existing key answers `400 userDataDuplicateKey` and changes nothing.
	 *
	 * WRITE FIRST, READ ONLY ON CONFLICT. A read before the write cannot be part of this: the create
	 * must work on a service that has never been deployed, which is exactly ADR-0004's bring-up order.
	 */
	putServiceEnv(input: { serviceId: string; key: string; value: string; signal: AbortSignal }): Promise<void>

	/** Delete one service-level variable by its record id. VERIFIED: `DELETE /user-data/{id}`. */
	deleteServiceEnv(input: { envId: string; signal: AbortSignal }): Promise<void>

	/**
	 * Read ONE project-level variable back, by record id. VERIFIED: `GET /project-env/{id}`.
	 * Read-only ON PURPOSE — see the note on this interface. Present so drift can be REPORTED.
	 */
	getProjectEnv(input: { projectEnvId: string; signal: AbortSignal }): Promise<ZeropsServiceEnv>

	// ── client: minting a credential ──────────────────────────────────────────────

	/**
	 * Mint a project-scoped INTEGRATION token. VERIFIED: `POST /client/{id}/integration-token`
	 * (`createIntegrationToken`), body `RequestClientIntegrationToken` — `name` and `projects` are its two
	 * required members — response `ResponseClientIntegrationTokenRaw`, whose `required` list contains
	 * `token`.
	 *
	 * WHAT IT IS FOR. A control plane deployed on Zerops holds a Zerops credential, and it must not be the
	 * personal access token an operator or a bootstrap authenticated with: that one carries account-wide
	 * admin rights (module header). An integration token left at client `NO_ACCESS` with one project
	 * granted `ADMIN` can do nothing outside that project.
	 *
	 * `roleCode` IS ALWAYS SENT, even when its value is the schema's own default, for the reason
	 * `compile.ts` writes `envIsolation` instead of inheriting it: a security-relevant field that never
	 * reaches the wire is a field nobody can review.
	 *
	 * `canCreateProjects` IS EXPOSED, because a control plane that provisions app namespaces cannot work
	 * without it: every namespace preset creates a project, and `POST /client/{id}/project/import` answers
	 * `403 insufficientPermissions` to a token without the flag (measured live, 2026-08-18; ADR-0034).
	 * The cost is real and bounded — the token receives `OWNER` on what it creates, and nothing else:
	 * `roleCode` stays `NO_ACCESS`, so a project it never created and was never granted stays unreachable.
	 *
	 * NOT EXPOSED, deliberately: `canViewFinances` / `canEditFinances`. Both default to `false`, and
	 * fabrika has no use for either.
	 *
	 * UNVERIFIED BEHAVIOUR: EVERYTHING AT RUNTIME. No token has ever been minted against a real account —
	 * doing so is a mutation, not an inspection — so the shapes below are the published document's and the
	 * behaviours are unmeasured: whether a repeated `name` conflicts, whether client `NO_ACCESS` alongside
	 * a project grant is accepted, and what the token's own prefix or length looks like.
	 *
	 * THE RESPONSE CARRIES A SECRET, so the implementation redacts the server's message from any error it
	 * raises. This is the one endpoint whose error envelope could quote a token value back.
	 */
	createIntegrationToken(input: {
		clientId: string
		/** The token's label in the Zerops UI. Not a secret and not unique as far as any document says. */
		name: string
		/** Per-project grants. `ADMIN` is what a control plane needs on a project it deploys into. */
		projects: readonly { projectId: string; roleCode: ZeropsRoleCode }[]
		/** The client-wide role. Defaults to `NO_ACCESS`, which is the entire point of a scoped token. */
		roleCode?: ZeropsRoleCode
		/** Let the token create projects, which it then OWNS. Required to provision app namespaces (ADR-0034). */
		canCreateProjects?: boolean
		signal: AbortSignal
	}): Promise<ZeropsIntegrationToken>

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
	/** How the user-data writes wait for their platform process. Tests pass a sleeper that does not sleep. */
	sleep?: Sleeper
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

const ROLE_CODES: readonly ZeropsRoleCode[] = ['OWNER', 'ADMIN', 'BASIC_USER', 'READ_ONLY', 'NO_ACCESS']

/** `undefined` means Zerops sent a role this build does not know — reported as absent, never as a guess. */
const asRoleCode = (value: unknown): ZeropsRoleCode | undefined => ROLE_CODES.find((role) => role === value)

const readIntegrationToken = (value: unknown): ZeropsIntegrationToken => ({
	id: str(value, 'id') ?? '',
	name: str(value, 'name') ?? '',
	token: str(value, 'token') ?? '',
	projects: arr(value, 'projects').map((entry) => ({
		projectId: str(entry, 'projectId') ?? '',
		roleCode: asRoleCode(prop(entry, 'roleCode')),
	})),
	roleCode: asRoleCode(prop(value, 'roleCode')),
})

const readServiceEnv = (value: unknown): ZeropsServiceEnv => ({
	id: str(value, 'id') ?? '',
	key: str(value, 'key') ?? '',
	content: str(value, 'content') ?? '',
	serviceStackId: str(value, 'serviceStackId'),
	type: str(value, 'type'),
})

/**
 * A non-2xx answer from the Zerops API. `code` is the platform's own error identifier, so a caller can
 * branch on `userDataDuplicateKey` rather than matching a prose message.
 */
export class ZeropsApiError extends Error {
	constructor(message: string, readonly status: number, readonly code: string) {
		super(message)
		this.name = 'ZeropsApiError'
	}
}

/** The platform's code for "this service stack already has a variable under that key". */
const USER_DATA_DUPLICATE_KEY = 'userDataDuplicateKey'

/** The platform's code for a service stack it cannot find — sent with a 400, not a 404. */
const ZEROPS_SERVICE_STACK_NOT_FOUND = 'serviceStackNotFound'

/**
 * The platform's code for "this service publishes no HTTP port", the answer `enableSubdomainAccess` gives
 * before a service's first deploy. Exported so a caller can say what is missing instead of relaying prose.
 */
export const ZEROPS_SERVICE_NOT_HTTP = 'serviceStackIsNotHttp'

/**
 * Turn a non-2xx response into a `ZeropsApiError`. Zerops answers with `{ error: { code, message, meta } }`
 * (the envelope observed live; the OpenAPI `Error` schema shows the inner `{ code, message }`).
 *
 * `redactDetail` drops the server's MESSAGE, which a validation error can fill with the value it
 * rejected. The CODE is a fixed identifier and is kept either way — without it nothing downstream can
 * tell a duplicate key from a missing service.
 */
const apiError = (label: string, status: number, body: unknown, redactDetail: boolean): ZeropsApiError => {
	const code = str(prop(body, 'error'), 'code') ?? str(body, 'code') ?? ''
	const message = redactDetail ? '' : (str(prop(body, 'error'), 'message') ?? str(body, 'message') ?? '')
	const detail = [code, message].filter((part) => part !== '').join(': ')
	return new ZeropsApiError(`zerops: ${label} failed (${status})${detail === '' ? '' : ` — ${detail.slice(0, 300)}`}`, status, code)
}

const timerSleep: Sleeper = (ms, signal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted) {
			resolve()
			return
		}
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort)
			resolve()
		}, ms)
		const onAbort = (): void => {
			clearTimeout(timer)
			resolve()
		}
		signal.addEventListener('abort', onAbort, { once: true })
	})

/** Build the real client. Every request carries the bearer and the run's signal. */
export const createZeropsApi = (options: ZeropsApiOptions): ZeropsApi => {
	const base = (options.baseUrl ?? ZEROPS_API_BASE).replace(/\/+$/, '')
	const doFetch = options.fetchImpl ?? fetch
	// Its own, rather than `collaborators`' — that module imports this one, so taking the value back would close a cycle.
	const sleep = options.sleep ?? timerSleep
	const abortError = (): DOMException => new DOMException('The operation was aborted', 'AbortError')
	const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError'
	const SERVICE_ENV_RESPONSE_MAX_BYTES = 8 * 1024 * 1024
	class ResponseByteBoundError extends Error {}

	const boundedJson = async (response: Response, label: string, maxBytes: number, signal: AbortSignal): Promise<unknown> => {
		if (signal.aborted) {
			void response.body?.cancel().catch(() => {})
			throw abortError()
		}
		const contentLength = response.headers.get('content-length')
		if (contentLength !== null) {
			const declaredBytes = Number(contentLength)
			if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
				void response.body?.cancel().catch(() => {})
				throw new ResponseByteBoundError(`zerops: ${label} response exceeded its byte bound`)
			}
		}
		if (response.body === null) return null
		const reader = response.body.getReader()
		let abortRead = (): void => {}
		const aborted = new Promise<never>((_resolve, reject) => {
			abortRead = (): void => {
				void reader.cancel().catch(() => {})
				reject(abortError())
			}
			signal.addEventListener('abort', abortRead, { once: true })
			if (signal.aborted) abortRead()
		})
		const chunks: Uint8Array[] = []
		let receivedBytes = 0
		try {
			while (true) {
				const next = await Promise.race([reader.read(), aborted])
				if (signal.aborted) throw abortError()
				if (next.done) break
				receivedBytes += next.value.byteLength
				if (receivedBytes > maxBytes) {
					void reader.cancel().catch(() => {})
					throw new ResponseByteBoundError(`zerops: ${label} response exceeded its byte bound`)
				}
				chunks.push(next.value)
			}
		} finally {
			signal.removeEventListener('abort', abortRead)
		}
		const bytes = new Uint8Array(receivedBytes)
		let offset = 0
		for (const chunk of chunks) {
			bytes.set(chunk, offset)
			offset += chunk.byteLength
		}
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
	}

	const request = async (
		label: string,
		method: string,
		path: string,
		/**
		 * `redactDetail` drops the server's message from the thrown error, keeping only its code. Set it on
		 * any call whose BODY carries a secret value: a validation error can quote what it rejected, and an
		 * error that echoes a secret into a deploy log is a leak whichever end wrote it.
		 * `omitErrorResponseDetails` also drops the code for upload flows whose response may carry a
		 * credential; nothing from that response body may reach an error.
		 */
		init: {
			body?: unknown
			signal: AbortSignal
			redactDetail?: boolean
			omitErrorResponseDetails?: boolean
			responseMaxBytes?: number
		},
	): Promise<unknown> => {
		if (init.signal.aborted) {
			throw abortError()
		}
		const headers: Record<string, string> = { authorization: `Bearer ${options.token}`, accept: 'application/json' }
		if (init.body !== undefined) {
			headers['content-type'] = 'application/json'
		}
		let response: Response
		try {
			response = await doFetch(`${base}${path}`, {
				method,
				headers,
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
				signal: init.signal,
			})
		} catch (error) {
			if (init.signal.aborted || isAbortError(error)) throw abortError()
			throw error
		}
		let payload: unknown
		try {
			payload = init.responseMaxBytes === undefined
				? await response.json()
				: await boundedJson(response, label, init.responseMaxBytes, init.signal)
		} catch (error) {
			if (init.signal.aborted || isAbortError(error)) throw abortError()
			if (error instanceof ResponseByteBoundError) throw error
			payload = null
		}
		if (!response.ok) {
			if (init.omitErrorResponseDetails === true) {
				throw new ZeropsApiError(`zerops: ${label} failed (${response.status})`, response.status, '')
			}
			throw apiError(label, response.status, payload, init.redactDetail === true)
		}
		return payload
	}

	const invalidResponse = (label: string): Error => new Error(`zerops: ${label} returned an invalid response`)

	const requiredString = (payload: unknown, key: string, label: string): string => {
		const value = str(payload, key)
		if (value === undefined || value.trim() === '') {
			throw invalidResponse(label)
		}
		return value
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

	/**
	 * Named so `putServiceEnv` can reach it: the conflict path needs the record id, and the ONE endpoint
	 * that hands it over on every service is `/env` (`/user-data` answers 400 unconditionally).
	 */
	const listServiceEnv: ZeropsApi['listServiceEnv'] = async ({ serviceId, signal }) => {
		const payload = await request('list service env', 'GET', `/service-stack/${serviceId}/env`, {
			signal,
			responseMaxBytes: SERVICE_ENV_RESPONSE_MAX_BYTES,
		})
		const items = prop(payload, 'items')
		if (!Array.isArray(items)) throw invalidResponse('list service env')
		return items.map(readServiceEnv)
	}

	const getProcess: ZeropsApi['getProcess'] = async ({ processId, signal }) =>
		readProcess(await request('get process', 'GET', `/process/${processId}`, { signal }))

	/**
	 * Wait out the `stack.updateUserData` process every user-data write answers with.
	 *
	 * While one runs the platform refuses the NEXT operation on that service with `400
	 * userDataSyncRunning` — which is how a deploy that wrote an app's environment and then asked for a
	 * build failed, one second before the sync it had started finished. Measured live: PENDING → RUNNING →
	 * FINISHED in about three seconds, on a deployed service and on one that has never had code alike.
	 *
	 * The response is recognised by `actionName`, not by having an `id`: a user-data RECORD carries an id
	 * too, and polling `/process/{recordId}` would hang instead of failing. An unrecognised response is
	 * left alone — nothing then says the write is still settling.
	 */
	const awaitUserDataSync = async (payload: unknown, label: string, signal: AbortSignal): Promise<void> => {
		const processId = str(payload, 'id')
		const action = str(payload, 'actionName')
		if (processId === undefined || processId.trim() === '' || action === undefined || action.trim() === '') {
			return
		}
		await waitForProcess({ api: { getProcess }, processId, sleep, signal, label })
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

		createAppVersion: async ({ serviceId, name, signal }) => {
			const body = name === undefined ? {} : { name }
			const payload = await request('create app-version', 'POST', `/service-stack/${serviceId}/app-version`, {
				body,
				signal,
				omitErrorResponseDetails: true,
			})
			const responseServiceId = requiredString(payload, 'serviceStackId', 'create app-version')
			if (responseServiceId !== serviceId) {
				throw invalidResponse('create app-version')
			}
			return {
				id: requiredString(payload, 'id', 'create app-version'),
				uploadUrl: requiredString(payload, 'uploadUrl', 'create app-version'),
			}
		},

		buildAndDeployAppVersion: async ({ appVersionId, zeropsYaml, zeropsYamlSetup, signal }) => {
			const body = zeropsYamlSetup === undefined ? { zeropsYaml } : { zeropsYaml, zeropsYamlSetup }
			// `redactDetail`, not `omitErrorResponseDetails`: this request body is the app's COMMITTED
			// descriptor and this response carries no upload URL, so there is nothing here to protect by
			// dropping the code as well — and a bare `(400)` is what made `userDataSyncRunning` cost a day.
			const payload = await request('build and deploy app-version', 'PUT', `/app-version/${appVersionId}/build-and-deploy`, {
				body,
				signal,
				redactDetail: true,
			})
			const processId = requiredString(payload, 'id', 'build and deploy app-version')
			const responseAppVersionId = str(prop(payload, 'appVersion'), 'id')
			if (responseAppVersionId !== undefined && (responseAppVersionId.trim() === '' || responseAppVersionId !== appVersionId)) {
				throw invalidResponse('build and deploy app-version')
			}
			return { ...readProcess(payload), id: processId, appVersionId }
		},

		deleteAppVersion: async ({ appVersionId, signal }) => {
			const payload = await request('delete app-version', 'DELETE', `/app-version/${appVersionId}`, {
				signal,
				omitErrorResponseDetails: true,
			})
			if (prop(payload, 'success') !== true) {
				throw invalidResponse('delete app-version')
			}
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

		getProcess,

		enableSubdomainAccess: async ({ serviceId, signal }) => {
			// No body: the operation takes none, and sending one would add a content-type the platform did not ask for.
			await request('enable subdomain access', 'PUT', `/service-stack/${serviceId}/enable-subdomain-access`, { signal })
		},

		getService: async ({ serviceId, signal }) => readService(await request('get service', 'GET', `/service-stack/${serviceId}`, { signal })),

		findService: async ({ projectId, hostname, signal }) => {
			try {
				return readService(await request('find service', 'GET', `/service-stack-by-name/${projectId}/${encodeURIComponent(hostname)}`, { signal }))
			} catch (error) {
				// A missing service is an answer, not a failure; anything else propagates. The live platform
				// says it as 400 `serviceStackNotFound` (docs/reference/zerops-platform.md), not as a 404.
				if (error instanceof ZeropsApiError && (error.status === 404 || error.code === ZEROPS_SERVICE_STACK_NOT_FOUND)) {
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

		listServiceEnv,

		createServiceEnv: async ({ serviceId, key, value, signal }) => {
			let started: unknown
			try {
				started = await request('create-only service env', 'POST', `/service-stack/${serviceId}/user-data`, {
					body: { key, content: value, sensitive: SENSITIVE_USER_DATA },
					signal,
					omitErrorResponseDetails: true,
				})
			} catch (error) {
				if (error instanceof Error && error.name === 'AbortError') throw error
				throw new Error('zerops: create-only service env failed')
			}
			await awaitUserDataSync(started, `the user-data sync on service ${serviceId}`, signal)
		},

		putServiceEnv: async ({ serviceId, key, value, signal }) => {
			const label = `the user-data sync on service ${serviceId}`
			// `redactDetail` on both writes: this is the one place a secret VALUE is in the request body.
			try {
				const created = await request('create service env', 'POST', `/service-stack/${serviceId}/user-data`, {
					body: { key, content: value, sensitive: SENSITIVE_USER_DATA },
					signal,
					redactDetail: true,
				})
				await awaitUserDataSync(created, label, signal)
				return
			} catch (error) {
				if (!(error instanceof ZeropsApiError) || error.code !== USER_DATA_DUPLICATE_KEY) {
					throw error
				}
			}
			// Only the conflict reads, and only then: the create must work on a service that has never been
			// deployed, which is the whole of ADR-0004's bring-up order.
			const existing = (await listServiceEnv({ serviceId, signal })).find((entry) => entry.key === key)
			if (existing === undefined || existing.id === '') {
				// The service declares the key in its own `zerops.yaml` (`type: ENV`), which conflicts on create
				// yet never appears in the env list. Replacing it here would be undone by the next deploy.
				throw new Error(
					`zerops: service ${serviceId} already defines \`${key}\` outside the environment API — it cannot be written`,
				)
			}
			const updated = await request('update service env', 'PUT', `/user-data/${existing.id}`, {
				body: { key, content: value, sensitive: SENSITIVE_USER_DATA },
				signal,
				redactDetail: true,
			})
			await awaitUserDataSync(updated, label, signal)
		},

		deleteServiceEnv: async ({ envId, signal }) => {
			const deleted = await request('delete service env', 'DELETE', `/user-data/${envId}`, { signal })
			await awaitUserDataSync(deleted, `the user-data sync for record ${envId}`, signal)
		},

		getProjectEnv: async ({ projectEnvId, signal }) =>
			readServiceEnv(await request('get project env', 'GET', `/project-env/${projectEnvId}`, { signal })),

		createIntegrationToken: async ({ clientId, name, projects, roleCode, canCreateProjects, signal }) =>
			// `redactDetail`: unlike every other write here the SECRET is in the RESPONSE, not the request, so
			// this is the one error envelope that could quote a minted token back at us.
			readIntegrationToken(
				await request('create integration token', 'POST', `/client/${clientId}/integration-token`, {
					body: {
						name,
						roleCode: roleCode ?? 'NO_ACCESS',
						// Always sent, like `roleCode`: a security-relevant field that never reaches the wire is a
						// field nobody can review.
						canCreateProjects: canCreateProjects ?? false,
						projects: projects.map((grant) => ({ projectId: grant.projectId, roleCode: grant.roleCode })),
					},
					signal,
					redactDetail: true,
				}),
			),

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

// ── waiting on a process ────────────────────────────────────────────────────────

/**
 * How often `waitForProcess` polls. The two process durations anyone has measured are 0.7 s
 * (`stack.enableSubdomainAccess`) and 2.6 s (`stack.updateUserData`), so 5 s — the platform DEPLOY's
 * interval — would spend most of its time asleep on a call that already finished.
 */
const PROCESS_POLL_INTERVAL_MS = 2_000

/** ~5 minutes. The slow case is an import that creates managed services, not a build; a build is polled through `/app-version`. */
const PROCESS_POLL_ATTEMPTS = 150

/**
 * Poll ONE process to completion.
 *
 * The same loop `installation-zerops`'s `deployService` runs over `/app-version`, run over `/process`
 * instead: read, decide ONLY on a status this build knows to be terminal, sleep, and give up on a deadline
 * of our own rather than on a coincidence. Returns the finished process so a caller can read
 * `actionName`/`appVersionId` off it.
 *
 * Anything outside `ZEROPS_PROCESS_TERMINAL` means "keep waiting", including a status this build has never
 * seen — which is why an unpublished vocabulary (see that constant) can cost a timeout and never a false
 * success. A non-`FINISHED` terminal status throws, naming the status and nothing else.
 */
export const waitForProcess = async (input: {
	api: Pick<ZeropsApi, 'getProcess'>
	processId: string
	sleep: Sleeper
	signal: AbortSignal
	/** What to call this process in a failure or timeout message. Defaults to its id. */
	label?: string
	intervalMs?: number
	attempts?: number
}): Promise<ZeropsProcess> => {
	const label = input.label ?? input.processId
	const intervalMs = input.intervalMs ?? PROCESS_POLL_INTERVAL_MS
	const attempts = input.attempts ?? PROCESS_POLL_ATTEMPTS
	for (let attempt = 0;; attempt += 1) {
		// A `Sleeper` resolves early on abort, so without this the loop would spin out its whole budget
		// against a cancelled run.
		if (input.signal.aborted) {
			throw new Error(`zerops: waiting for ${label} was cancelled`)
		}
		const process = await input.api.getProcess({ processId: input.processId, signal: input.signal })
		if (process.status !== undefined && ZEROPS_PROCESS_TERMINAL.has(process.status)) {
			if (process.status !== ZEROPS_PROCESS_FINISHED) {
				throw new Error(`zerops: ${label} finished as ${process.status}`)
			}
			return process
		}
		if (attempt >= attempts) {
			throw new Error(`zerops: ${label} did not finish in time`)
		}
		await input.sleep(intervalMs, input.signal)
	}
}
