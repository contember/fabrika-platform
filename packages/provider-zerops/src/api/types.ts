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

import type { Sleeper } from '../collaborators'

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
	/** Record classification, not a sensitivity or ownership guarantee; sensitive records can be USER. */
	type?: string
	/** Live service-env responses identify sensitive USER records independently of their type. */
	sensitive?: boolean
}

/**
 * A short-lived grant for the project's LOG service. VERIFIED: `ResponseProjectLog` — the field names and
 * types are exactly these. What the URLs speak was measured separately; see `readBuildLog`.
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
	/** RFC3339 stamp Zerops put at the head of the line, when the line carried one. */
	timestamp?: string
	/** The line as the log service wrote it, timestamp and tag included. */
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
	 * NOT `GET /service-stack/{id}/user-data`: it answers a list now (2026-08-21), but `/env` is the
	 * endpoint whose record ids `PUT`/`DELETE /user-data/{id}` take, and the list's paging terms were
	 * never verified — see `docs/reference/zerops-platform.md`. The `/env` reading omits
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
	 * One window of the project's log, narrowed to ONE app version.
	 *
	 * VERIFIED 2026-08-21 by measurement, not by document: the OpenAPI file stops at the grant, so the
	 * separate log service was read against a live project. `urlPlain` answers one
	 * `<RFC3339 timestamp> <tag> <message>` line per record and accepts `serviceStackId`, `limit`, `tags`
	 * and `desc`; `from` and unknown terms are accepted and silently ignored, so nothing may depend on them.
	 *
	 * ORDERING, also measured: `limit=N` without `desc` returns the NEWEST N records in ASCENDING timestamp
	 * order (`limit=3` against a log starting 15:50 answered 17:00:00, 17:00:00, 17:15:00), and `desc=1`
	 * returns the same newest N, newest first. So `desc` is needed neither for the `since` cut nor for a
	 * build longer than the limit: each poll re-reads the newest window and the caller's dedupe streams it.
	 *
	 * A version's BUILD lines carry the tag `zbuilder@<appVersionId>` and are produced on a separate
	 * builder stack, so they are selected by `tags` ALONE — combining that tag with the runtime
	 * `serviceStackId` matches nothing. RUNTIME lines carry no version marker at all and the runtime
	 * service's window mixes every version that ever ran, so they are selected by `serviceStackId` and cut
	 * at `since` (the version's `build.pipelineStart`). Without `since` no runtime line is read: a line
	 * from an earlier version is worse in a run log than a missing one. The cut is by TIME, not identity —
	 * the outgoing container keeps logging until it is replaced, so its lines stamped after `since` still
	 * pass, and only the earlier version's older history is excluded.
	 *
	 * The two windows are read INDEPENDENTLY: one failing must not discard what the other returned, and only
	 * a failure of every window attempted is raised. The driver then treats that as non-fatal anyway — log
	 * relay degrades to "no lines" and the deploy succeeds or fails on `/app-version` status alone. A log
	 * service must never be able to fail a deploy.
	 */
	readBuildLog(input: {
		access: ZeropsLogAccess
		serviceId: string
		/** Select this version's build lines by their `zbuilder@` tag; without it no build line is read. */
		appVersionId?: string
		/** RFC3339 lower bound for runtime lines, normally `build.pipelineStart`; without it none are read. */
		since?: string
		limit?: number
		signal: AbortSignal
	}): Promise<ZeropsLogLine[]>
}

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
