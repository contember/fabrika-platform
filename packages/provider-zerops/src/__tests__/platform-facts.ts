// ONE table of Zerops platform facts, and the runner both consumers drive it with.
//
// WHY IT EXISTS. Every `### Verified live` section of `docs/reference/zerops-platform.md` was produced by
// hand and re-checked by nobody, and the local double encoded what someone BELIEVED about the platform.
// Twice in one day the double was wrong in a way no unit test could see, and both were found by a failed
// live deploy. A fact is a ROW here from now on: the emulator test asserts every row it models
// (`emulator: true`), the opt-in live suite asserts every row it can probe (`live !== 'not-probed'`), and
// a wrong row fails BOTH — which is the whole point of one table.
//
// NOTHING IS EXPORTED FROM THE PACKAGE. This file lives under `src/__tests__/`, which
// `package.json#files` excludes, so it never ships and adds no public API. `@fabrika/local-stack` (private)
// imports it by relative path; the reverse edge is forbidden by `scripts/release.ts`.
//
// THE ROWS RUN IN TABLE ORDER on both sides, and some depend on the row before: the import row captures
// the service ids every later row substitutes, and the deleted-service rows read what the delete row
// removed. Adding a row in the middle is fine; reordering is not.
//
// SECURITY. `transport.token` is a Zerops access token. It is written into one header and never logged,
// never asserted on, and never put in a failure message. The values the rows write are literals, not
// credentials, and are still not printed.

/** How much a row costs to probe against a real account. */
export type FactLiveClass =
	/** Needs only the throwaway project. Seconds. */
	| 'fast'
	/** Needs the imported throwaway service the table's import row creates. Seconds. */
	| 'service'
	/** Needs a real build. Minutes, and opt-in behind `FABRIKA_LIVE_ZEROPS_SLOW=1`. */
	| 'build'
	/** Recorded, deliberately not probed — `liveNote` says why. */
	| 'not-probed'

export type FactMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

/**
 * One assertion about a single field of a response body.
 *
 * `equals` and `oneOf` values pass through placeholder substitution, so a row can say "this field is the
 * id we imported" without the runner knowing what an id is.
 */
export type FactFieldCheck =
	| { kind: 'string' }
	| { kind: 'nonEmptyString' }
	/** Present and a string, and the value is NEVER rendered into a failure message — for a field that may carry a credential. */
	| { kind: 'presentUnrendered' }
	| { kind: 'lengthEquals'; length: number }
	| { kind: 'equals'; value: string }
	| { kind: 'oneOf'; values: readonly string[] }
	| { kind: 'boolean'; value: boolean }
	| { kind: 'array' }
	| { kind: 'emptyArray' }
	| { kind: 'nonEmptyArray' }
	| { kind: 'absent' }

/** What a call must answer. `code` is the platform's own error identifier, which is what a client branches on. */
export interface FactExpectation {
	status: number
	/** `error.code` in the platform's envelope. */
	code?: string
	/** A substring `error.message` must contain. Never a whole message — the platform quotes rejected values. */
	messageContains?: string
	/** Field path → check. Paths are dotted; see `resolvePath` for the two bracket forms. */
	bodyShape?: Readonly<Record<string, FactFieldCheck>>
}

/** One request in a row's sequence. */
export interface FactStep {
	method: FactMethod
	/** Path under the API base, with `{name}` placeholders the context fills. */
	path: string
	/** JSON body; every string inside it is substituted too. */
	body?: unknown
	/** What this step must answer. Absent on a setup step whose only job is to arrange state. */
	expect?: FactExpectation
	/**
	 * A path to the process id (or ids) this step's response names; the runner polls each to a terminal
	 * status before continuing. `'id'` for a single process, `'serviceStacks[*].processes[*].id'` for an import.
	 */
	awaitProcess?: string
	/** Context name → path in this step's response body. Later steps and rows substitute the captured value. */
	capture?: Readonly<Record<string, string>>
}

/**
 * One platform fact.
 *
 * `section` names the heading in `docs/reference/zerops-platform.md` the fact was recorded under, with the
 * line it started on when the row was written — a line number drifts, a heading does not, so both are given.
 */
export interface PlatformFact {
	id: string
	section: string
	/** Steps that arrange the state the fact needs. A failure here is reported as a setup failure. */
	setup?: readonly FactStep[]
	/** The call the fact is about. */
	request: { method: FactMethod; path: string; body?: unknown }
	expect: FactExpectation
	/** Further calls that are part of the same fact, each with its own expectation. */
	then?: readonly FactStep[]
	/** Poll the process the request's response names before running `then`. */
	awaitProcess?: string
	capture?: Readonly<Record<string, string>>
	live: FactLiveClass
	/** Why the account is not probed. Required when `live` is `'not-probed'`. */
	liveNote?: string
	emulator: boolean
	/** Why the double does not model it. Required when `emulator` is false. */
	emulatorNote?: string
	/**
	 * Names a probe the generic runner cannot express (an upload, an archive, a build). The consumer
	 * supplies it; a row naming a script the consumer did not supply is an error, never a silent pass.
	 */
	script?: string
}

// ── the table ───────────────────────────────────────────────────────────────────

const SECTION_2026_08_03 = 'Verified live (2026-08-03, account `prg1`) — docs/reference/zerops-platform.md:208'
const SECTION_2026_08_05 = 'Verified live (2026-08-05) — the user-data write path — docs/reference/zerops-platform.md:240'
const SECTION_OVERRIDE = '`override` is a name-collision escape, not an update — docs/reference/zerops-platform.md:293'
const SECTION_SUBDOMAIN = 'An import document cannot establish a subdomain — docs/reference/zerops-platform.md:413'
const SECTION_SUBDOMAIN_NAME = '`zeropsSubdomain` is a NAME, not a state — docs/reference/zerops-platform.md:445'
const SECTION_PROXY_FIRST = 'Verified live (2026-08-08) — a proxy before it fronts anything — docs/reference/zerops-platform.md:460'
const SECTION_SERVICES_IMPORT =
	'Verified live (2026-08-10) — a services-only import into an operator-created project — docs/reference/zerops-platform.md:486'
const SECTION_BUILD_SOURCE = 'Verified live (2026-08-11) — where a build source lives — docs/reference/zerops-platform.md:524'
const SECTION_NAMESPACE = 'Verified live (2026-08-18) — provisioning an app namespace — docs/reference/zerops-platform.md:665'
const SECTION_TOKEN_CAPABILITIES =
	'Verified live (2026-08-21) — an integration token can read its own capabilities — docs/reference/zerops-platform.md:687'
const SECTION_BY_NAME = 'Verified live (2026-08-21) — a missing service by name is a 400 — docs/reference/zerops-platform.md:705'
const SECTION_UNPACKER = 'Verified live (2026-08-21) — the unpacker needs directory entries — docs/reference/zerops-platform.md:720'
const SECTION_DELETE = 'Verified live (2026-08-21) — deleting a service, and what an absent id answers — docs/reference/zerops-platform.md:739'
const SECTION_USER_DATA_PROCESS = 'Verified live (2026-08-19) — a user-data write is an asynchronous process — docs/reference/zerops-platform.md:766'
const SECTION_POSTGRES_TLS = 'Verified live (2026-08-19) — PostgreSQL TLS is per service type — docs/reference/zerops-platform.md:786'
const SECTION_REST_API = 'REST API — docs/reference/zerops-platform.md:147'
const SECTION_HIERARCHY = 'Hierarchy and isolation — docs/reference/zerops-platform.md:28'

/** The keys the rows write. Literals, not credentials — nothing here is a secret and nothing is printed. */
const KEY_PROCESS = 'FABRIKA_FACT_PROCESS'
const KEY_DUPLICATE = 'FABRIKA_FACT_DUPLICATE'
const KEY_SENSITIVE = 'FABRIKA_FACT_SENSITIVE'
const KEY_REPLACE = 'FABRIKA_FACT_REPLACE'
const KEY_DELETE = 'FABRIKA_FACT_DELETE'

/** A `zerops.yaml` the compiler would refuse to emit: it names a setup with no build source. */
const IMPORT_ZEROPS_SETUP_WITHOUT_SOURCE = [
	'services:',
	'  - hostname: {setupProbeHostname}',
	'    type: alpine/bun@1.3',
	'    envIsolation: service',
	'    zeropsSetup: {setupProbeHostname}',
	'',
].join('\n')

/** The provisioning document the table's own throwaway services come from. */
const importDocument = (options: { override: boolean; maxContainers?: number }): string =>
	[
		'services:',
		'  - hostname: {hostname}',
		'    type: alpine/bun@1.3',
		'    envIsolation: service',
		'    startWithoutCode: true',
		...(options.override ? ['    override: true'] : []),
		...(options.maxContainers === undefined ? [] : [`    maxContainers: ${options.maxContainers}`]),
		'  - hostname: {deleteHostname}',
		'    type: alpine/bun@1.3',
		'    envIsolation: service',
		'    startWithoutCode: true',
		...(options.override ? ['    override: true'] : []),
		'',
	].join('\n')

/** One runtime service, so a create response can be counted on its own. */
const COUNT_IMPORT_DOCUMENT = [
	'services:',
	'  - hostname: {countHostname}',
	'    type: alpine/bun@1.3',
	'    envIsolation: service',
	'    startWithoutCode: true',
	'    override: true',
	'',
].join('\n')

/** The same document with the flag the platform accepts and drops. */
const IMPORT_WITH_SUBDOMAIN_FLAG = [
	'services:',
	'  - hostname: {hostname}',
	'    type: alpine/bun@1.3',
	'    envIsolation: service',
	'    startWithoutCode: true',
	'    override: true',
	'    enableSubdomainAccess: true',
	'',
].join('\n')

/**
 * Every fact a client's behaviour depends on, in the order the two consumers run them.
 *
 * The classes: `fast` needs the project alone, `service` needs the services the import row creates,
 * `build` needs a real build and is opt-in, `not-probed` is recorded with the reason it cannot be a probe.
 */
export const PLATFORM_FACTS: readonly PlatformFact[] = [
	// ── the project alone ────────────────────────────────────────────────────────
	{
		id: 'service-by-name-absent-is-400',
		section: SECTION_BY_NAME,
		request: { method: 'GET', path: '/service-stack-by-name/{projectId}/{absentHostname}' },
		expect: { status: 400, code: 'serviceStackNotFound', messageContains: 'Service stack not found' },
		live: 'fast',
		emulator: true,
	},
	{
		id: 'error-envelope-shape',
		section: SECTION_2026_08_05,
		request: { method: 'GET', path: '/service-stack-by-name/{projectId}/{absentHostname}' },
		expect: {
			status: 400,
			bodyShape: { 'error.code': { kind: 'nonEmptyString' }, 'error.message': { kind: 'nonEmptyString' } },
		},
		live: 'fast',
		emulator: true,
	},
	{
		id: 'project-env-isolation-is-write-only',
		section: SECTION_HIERARCHY,
		request: { method: 'GET', path: '/project/{projectId}' },
		expect: { status: 200, bodyShape: { id: { kind: 'nonEmptyString' }, envIsolation: { kind: 'absent' } } },
		live: 'fast',
		emulator: true,
	},
	{
		id: 'project-log-grant-shape',
		section: SECTION_REST_API,
		request: { method: 'GET', path: '/project/{projectId}/log' },
		expect: {
			status: 200,
			bodyShape: {
				url: { kind: 'string' },
				urlPlain: { kind: 'string' },
				urlInfo: { kind: 'string' },
				urlUi: { kind: 'string' },
				// A short-lived bearer for the log service: asserted present, never rendered into a failure.
				accessToken: { kind: 'presentUnrendered' },
				expiration: { kind: 'string' },
			},
		},
		live: 'fast',
		emulator: true,
	},
	{
		id: 'app-version-missing-id-is-400',
		section: SECTION_USER_DATA_PROCESS,
		request: { method: 'GET', path: '/app-version/{absentAppVersionId}' },
		// Status only: the platform's code for this one was never recorded, and a bare 400 from this family
		// identifies no condition — which is the fact.
		expect: { status: 400 },
		live: 'fast',
		emulator: true,
	},
	{
		id: 'import-zerops-setup-needs-build-from-git',
		section: SECTION_2026_08_03,
		request: {
			method: 'POST',
			path: '/project/{projectId}/service-stack/import',
			body: { yaml: IMPORT_ZEROPS_SETUP_WITHOUT_SOURCE },
		},
		expect: { status: 400, code: 'projectImportInvalidParameter' },
		live: 'fast',
		emulator: true,
	},
	{
		id: 'user-info-is-readable',
		section: SECTION_TOKEN_CAPABILITIES,
		request: { method: 'GET', path: '/user/info' },
		expect: { status: 200, bodyShape: { id: { kind: 'nonEmptyString' } } },
		live: 'fast',
		emulator: false,
		emulatorNote: 'nothing in fabrika reads `/user/info`, so the double would be inventing a shape to answer it',
	},

	// ── one import, and the services every later row uses ────────────────────────
	{
		id: 'import-creates-a-service-and-returns-its-processes',
		section: SECTION_SERVICES_IMPORT,
		request: { method: 'POST', path: '/project/{projectId}/service-stack/import', body: { yaml: importDocument({ override: true }) } },
		expect: {
			status: 200,
			bodyShape: {
				'serviceStacks[name={hostname}].id': { kind: 'nonEmptyString' },
				'serviceStacks[name={hostname}].processes': { kind: 'nonEmptyArray' },
				'serviceStacks[name={deleteHostname}].id': { kind: 'nonEmptyString' },
			},
		},
		awaitProcess: 'serviceStacks[*].processes[*].id',
		capture: {
			serviceId: 'serviceStacks[name={hostname}].id',
			deleteServiceId: 'serviceStacks[name={deleteHostname}].id',
		},
		live: 'service',
		emulator: true,
	},
	{
		id: 'import-process-count-per-service',
		section: SECTION_SERVICES_IMPORT,
		// Its OWN service: the count is a property of a CREATE response, and the row above already consumed
		// the only other create this run makes.
		request: { method: 'POST', path: '/project/{projectId}/service-stack/import', body: { yaml: COUNT_IMPORT_DOCUMENT } },
		// Two per RUNTIME service. The managed half (exactly one) needs a database service the suite will not
		// provision, so that half stays prose in the reference doc.
		expect: { status: 200, bodyShape: { 'serviceStacks[name={countHostname}].processes': { kind: 'lengthEquals', length: 2 } } },
		awaitProcess: 'serviceStacks[*].processes[*].id',
		capture: { countServiceId: 'serviceStacks[name={countHostname}].id' },
		live: 'service',
		emulator: false,
		emulatorNote:
			'the double creates exactly one `stack.create` per created service; splitting managed from runtime needs a service catalog nobody has written down, and guessing one is what this table exists to stop',
	},
	{
		id: 'service-by-name-present-is-200',
		section: SECTION_BY_NAME,
		request: { method: 'GET', path: '/service-stack-by-name/{projectId}/{hostname}' },
		expect: { status: 200, bodyShape: { id: { kind: 'equals', value: '{serviceId}' }, name: { kind: 'equals', value: '{hostname}' } } },
		live: 'service',
		emulator: true,
	},
	{
		id: 'import-unchanged-is-a-noop',
		section: SECTION_OVERRIDE,
		request: { method: 'POST', path: '/project/{projectId}/service-stack/import', body: { yaml: importDocument({ override: true }) } },
		expect: { status: 200, bodyShape: { 'serviceStacks[name={hostname}].processes': { kind: 'emptyArray' } } },
		live: 'service',
		emulator: true,
	},
	{
		id: 'import-ignores-changed-fields',
		section: SECTION_OVERRIDE,
		request: {
			method: 'POST',
			path: '/project/{projectId}/service-stack/import',
			body: { yaml: importDocument({ override: true, maxContainers: 3 }) },
		},
		// Zero processes IS the fact: a changed sizing field starts nothing, so the re-apply reconciles nothing.
		expect: { status: 200, bodyShape: { 'serviceStacks[name={hostname}].processes': { kind: 'emptyArray' } } },
		live: 'service',
		emulator: true,
	},
	{
		id: 'import-without-override-is-400',
		section: SECTION_OVERRIDE,
		request: { method: 'POST', path: '/project/{projectId}/service-stack/import', body: { yaml: importDocument({ override: false }) } },
		expect: { status: 400, code: 'serviceStackNameUnavailable' },
		live: 'service',
		emulator: true,
	},
	{
		id: 'import-drops-enable-subdomain-access',
		section: SECTION_SUBDOMAIN,
		request: { method: 'POST', path: '/project/{projectId}/service-stack/import', body: { yaml: IMPORT_WITH_SUBDOMAIN_FLAG } },
		expect: { status: 200 },
		then: [{
			method: 'GET',
			path: '/service-stack/{serviceId}',
			expect: { status: 200, bodyShape: { subdomainAccess: { kind: 'boolean', value: false } } },
		}],
		live: 'service',
		emulator: true,
	},
	{
		id: 'enable-subdomain-before-deploy-400',
		section: SECTION_SUBDOMAIN,
		request: { method: 'PUT', path: '/service-stack/{serviceId}/enable-subdomain-access' },
		expect: { status: 400, code: 'serviceStackIsNotHttp', messageContains: 'not http' },
		live: 'service',
		emulator: true,
	},
	{
		id: 'trigger-pipeline-needs-a-source',
		section: SECTION_BUILD_SOURCE,
		// STATUS ONLY. The platform's refusal is shaped by which fields the body carries (`Service stack not
		// found` for an empty body, `Invalid parameter provided` with only `zeropsSetup`), and neither code was
		// ever read off the wire — so the row asserts what was measured and no more.
		request: { method: 'PUT', path: '/service-stack/{serviceId}/trigger-pipeline', body: {} },
		expect: { status: 400 },
		live: 'service',
		emulator: true,
	},
	{
		id: 'user-data-list-always-400',
		section: SECTION_2026_08_03,
		request: { method: 'GET', path: '/service-stack/{serviceId}/user-data' },
		expect: { status: 400, code: 'serviceStackNotFound' },
		live: 'service',
		emulator: true,
	},
	{
		id: 'env-list-is-the-read-path',
		section: SECTION_2026_08_05,
		request: { method: 'GET', path: '/service-stack/{serviceId}/env' },
		expect: { status: 200, bodyShape: { items: { kind: 'array' } } },
		live: 'service',
		emulator: true,
	},
	{
		id: 'user-data-write-is-a-process',
		section: SECTION_USER_DATA_PROCESS,
		request: {
			method: 'POST',
			path: '/service-stack/{serviceId}/user-data',
			body: { key: KEY_PROCESS, content: 'fact-one', sensitive: true },
		},
		// 200, not 201, and the PROCESS rather than the record it created.
		expect: {
			status: 200,
			bodyShape: {
				id: { kind: 'nonEmptyString' },
				actionName: { kind: 'equals', value: 'stack.updateUserData' },
				status: { kind: 'oneOf', values: ['PENDING', 'RUNNING', 'FINISHED'] },
			},
		},
		awaitProcess: 'id',
		live: 'service',
		emulator: true,
	},
	{
		id: 'user-data-post-duplicate-key',
		section: SECTION_2026_08_05,
		setup: [{
			method: 'POST',
			path: '/service-stack/{serviceId}/user-data',
			body: { key: KEY_DUPLICATE, content: 'fact-one', sensitive: true },
			awaitProcess: 'id',
		}],
		request: {
			method: 'POST',
			path: '/service-stack/{serviceId}/user-data',
			body: { key: KEY_DUPLICATE, content: 'fact-two', sensitive: true },
		},
		expect: { status: 400, code: 'userDataDuplicateKey' },
		live: 'service',
		emulator: true,
	},
	{
		id: 'user-data-write-requires-sensitive',
		section: SECTION_NAMESPACE,
		// The meta the platform sends is `{"sensitive":["field is required"]}`; its envelope position is
		// recorded nowhere, so the row asserts the code and leaves the meta to the reference doc.
		request: { method: 'POST', path: '/service-stack/{serviceId}/user-data', body: { key: KEY_SENSITIVE, content: 'fact-one' } },
		expect: { status: 400, code: 'invalidUserInput' },
		live: 'service',
		emulator: true,
	},
	{
		id: 'zerops-prefix-forbidden',
		section: SECTION_2026_08_03,
		request: {
			method: 'POST',
			path: '/service-stack/{serviceId}/user-data',
			body: { key: 'ZEROPS_FABRIKA_FACT', content: 'fact-one', sensitive: true },
		},
		expect: { status: 400, code: 'userDataZeropsPrefixForbidden' },
		live: 'service',
		emulator: true,
	},
	{
		id: 'put-user-data-needs-key-and-content',
		section: SECTION_2026_08_05,
		setup: [
			{
				method: 'POST',
				path: '/service-stack/{serviceId}/user-data',
				body: { key: KEY_REPLACE, content: 'fact-one', sensitive: true },
				awaitProcess: 'id',
			},
			{
				method: 'GET',
				path: '/service-stack/{serviceId}/env',
				capture: { replaceEnvId: `items[key=${KEY_REPLACE}].id` },
			},
		],
		request: { method: 'PUT', path: '/user-data/{replaceEnvId}', body: { content: 'fact-two', sensitive: true } },
		expect: { status: 400, code: 'invalidUserInput' },
		live: 'service',
		emulator: true,
	},
	{
		id: 'put-user-data-replaces-in-place',
		section: SECTION_2026_08_05,
		request: {
			method: 'PUT',
			path: '/user-data/{replaceEnvId}',
			body: { key: KEY_REPLACE, content: 'fact-two', sensitive: true },
		},
		expect: { status: 200, bodyShape: { actionName: { kind: 'equals', value: 'stack.updateUserData' } } },
		awaitProcess: 'id',
		then: [{
			method: 'GET',
			path: '/service-stack/{serviceId}/env',
			expect: {
				status: 200,
				bodyShape: {
					[`items[key=${KEY_REPLACE}].id`]: { kind: 'equals', value: '{replaceEnvId}' },
					[`items[key=${KEY_REPLACE}].content`]: { kind: 'equals', value: 'fact-two' },
				},
			},
		}],
		live: 'service',
		emulator: true,
	},
	{
		id: 'delete-user-data-is-a-process',
		section: SECTION_USER_DATA_PROCESS,
		setup: [
			{
				method: 'POST',
				path: '/service-stack/{serviceId}/user-data',
				body: { key: KEY_DELETE, content: 'fact-one', sensitive: true },
				awaitProcess: 'id',
			},
			{ method: 'GET', path: '/service-stack/{serviceId}/env', capture: { deleteEnvId: `items[key=${KEY_DELETE}].id` } },
		],
		request: { method: 'DELETE', path: '/user-data/{deleteEnvId}' },
		expect: { status: 200, bodyShape: { actionName: { kind: 'equals', value: 'stack.updateUserData' } } },
		awaitProcess: 'id',
		live: 'service',
		emulator: true,
	},
	{
		id: 'subdomain-name-before-deploy',
		section: SECTION_PROXY_FIRST,
		request: { method: 'GET', path: '/service-stack/{serviceId}/env' },
		expect: {
			status: 200,
			bodyShape: {
				'items[key=zeropsSubdomain].content': { kind: 'nonEmptyString' },
				'items[key=zeropsSubdomain].type': { kind: 'equals', value: 'READ_ONLY' },
			},
		},
		live: 'service',
		emulator: false,
		emulatorNote:
			"the double's `/env` returns only records it was told to write; generating the platform's own variables would change what the local stack publishes",
	},

	// ── the build-length probe ───────────────────────────────────────────────────
	{
		id: 'unpacker-flat-archive-fails-the-build',
		section: SECTION_UNPACKER,
		request: { method: 'PUT', path: '/app-version/{appVersionId}/build-and-deploy' },
		expect: { status: 200 },
		script: 'unpacker-flat-archive',
		live: 'build',
		emulator: false,
		emulatorNote: 'the double has none of the three upload routes and runs no build',
	},
	{
		id: 'unpacker-directory-entries-build-active',
		section: SECTION_UNPACKER,
		request: { method: 'PUT', path: '/app-version/{appVersionId}/build-and-deploy' },
		expect: { status: 200 },
		script: 'unpacker-directory-entries',
		live: 'build',
		emulator: false,
		emulatorNote: 'the double has none of the three upload routes and runs no build',
	},

	// ── deleting, and what an absent id answers ──────────────────────────────────
	{
		id: 'delete-service-is-a-process',
		section: SECTION_DELETE,
		request: { method: 'DELETE', path: '/service-stack/{deleteServiceId}' },
		expect: {
			status: 200,
			bodyShape: {
				id: { kind: 'nonEmptyString' },
				status: { kind: 'equals', value: 'PENDING' },
				actionName: { kind: 'equals', value: 'stack.delete' },
				serviceStackId: { kind: 'equals', value: '{deleteServiceId}' },
				projectId: { kind: 'equals', value: '{projectId}' },
			},
		},
		awaitProcess: 'id',
		live: 'service',
		emulator: true,
	},
	{
		id: 'deleted-service-reads-400',
		section: SECTION_DELETE,
		request: { method: 'GET', path: '/service-stack/{deleteServiceId}' },
		expect: { status: 400, code: 'serviceStackNotFound' },
		then: [
			{
				method: 'GET',
				path: '/service-stack-by-name/{projectId}/{deleteHostname}',
				expect: { status: 400, code: 'serviceStackNotFound' },
			},
			{ method: 'DELETE', path: '/service-stack/{deleteServiceId}', expect: { status: 400, code: 'serviceStackNotFound' } },
		],
		live: 'service',
		emulator: true,
	},
	{
		id: 'user-data-list-absent-service-is-400',
		section: SECTION_DELETE,
		request: { method: 'GET', path: '/service-stack/{deleteServiceId}/user-data' },
		expect: { status: 400, code: 'serviceStackNotFound' },
		live: 'service',
		emulator: true,
	},
	{
		id: 'user-data-post-absent-service-is-400',
		section: SECTION_DELETE,
		request: {
			method: 'POST',
			path: '/service-stack/{deleteServiceId}/user-data',
			body: { key: KEY_PROCESS, content: 'fact-one', sensitive: true },
		},
		expect: { status: 400, code: 'serviceStackNotFound' },
		live: 'service',
		emulator: true,
	},

	// ── recorded, deliberately not probed ────────────────────────────────────────
	{
		id: 'import-returns-before-services-exist',
		section: SECTION_SERVICES_IMPORT,
		request: { method: 'GET', path: '/project/{projectId}/service-stack' },
		expect: { status: 200, bodyShape: { 'list[name={hostname}].status': { kind: 'equals', value: 'NEW' } } },
		live: 'not-probed',
		liveNote: "the reading is a race against the platform's own ~15 s sequencing; a probe would be flaky, not wrong",
		emulator: false,
		emulatorNote: 'the double creates services `ACTIVE` at once, and making it sequential would change every local bring-up',
	},
	{
		id: 'build-and-deploy-refused-during-sync',
		section: SECTION_USER_DATA_PROCESS,
		request: { method: 'PUT', path: '/app-version/{appVersionId}/build-and-deploy' },
		expect: { status: 400, code: 'userDataSyncRunning' },
		live: 'not-probed',
		liveNote: 'needs a built app version AND a race against a user-data process that finishes in ~3 s',
		emulator: false,
		emulatorNote: 'the double has no `build-and-deploy` route',
	},
	{
		id: 'env-omits-zerops-yaml-vars',
		section: SECTION_2026_08_05,
		request: { method: 'GET', path: '/service-stack/{serviceId}/env' },
		expect: { status: 200 },
		live: 'not-probed',
		liveNote: 'needs a deployed service whose `zerops.yaml` declares `run.envVariables`, which is a build',
		emulator: false,
		emulatorNote: 'the double stores no `type: ENV` records, so it cannot omit them',
	},
	{
		id: 'enable-subdomain-readback-lag',
		section: SECTION_SUBDOMAIN,
		request: { method: 'GET', path: '/service-stack/{serviceId}' },
		expect: { status: 200 },
		live: 'not-probed',
		liveNote: 'the fact is "the read-back can still be false" — one run needed a second read 3 s later, so no assertion can hold either way',
		emulator: false,
		emulatorNote: 'the double sets `subdomainAccess` synchronously',
	},
	{
		id: 'enable-subdomain-twice-fails-its-process',
		section: SECTION_SUBDOMAIN,
		request: { method: 'PUT', path: '/service-stack/{serviceId}/enable-subdomain-access' },
		expect: { status: 200 },
		live: 'not-probed',
		liveNote: 'needs a service with a deployed HTTP port and an established subdomain, which is a build',
		emulator: false,
		emulatorNote: "the double's process always reaches FINISHED, where the platform's FAILS",
	},
	{
		id: 'subdomain-name-is-not-a-state',
		section: SECTION_SUBDOMAIN_NAME,
		request: { method: 'GET', path: '/service-stack/{serviceId}/env' },
		expect: { status: 200 },
		live: 'not-probed',
		liveNote: 'needs a deployed service, an enable and a disable — a build plus a public host the suite must not leave behind',
		emulator: false,
		emulatorNote: 'the double generates no `zeropsSubdomain`',
	},
	{
		id: 'import-start-without-code-is-destructive',
		section: SECTION_OVERRIDE,
		request: { method: 'POST', path: '/project/{projectId}/service-stack/import' },
		expect: { status: 200 },
		live: 'not-probed',
		liveNote: 'needs a service carrying code, and the probe destroys it — the fact is why a provisioning document is first-bring-up only',
		emulator: false,
		emulatorNote: 'the double activates no app version from an import',
	},
	{
		id: 'app-version-status-enum',
		section: SECTION_REST_API,
		request: { method: 'GET', path: '/app-version/{appVersionId}' },
		expect: { status: 200 },
		live: 'not-probed',
		liveNote: 'an app version exists only after a build; the two unpacker rows assert two members of the enum and nothing asserts closure',
		emulator: false,
		emulatorNote: 'the double models three of the thirteen statuses',
	},
	{
		id: 'project-delete-is-a-process',
		section: SECTION_DELETE,
		request: { method: 'DELETE', path: '/project/{projectId}' },
		expect: { status: 200, bodyShape: { actionName: { kind: 'equals', value: 'project.delete' } } },
		live: 'not-probed',
		liveNote: 'the suite never deletes a project — it is given one and leaves it standing',
		emulator: false,
		emulatorNote: 'the double has no project delete, because nothing in fabrika deletes a project',
	},
	{
		id: 'project-import-needs-can-create-projects',
		section: SECTION_NAMESPACE,
		request: { method: 'POST', path: '/client/{clientId}/project/import' },
		expect: { status: 403, code: 'insufficientPermissions' },
		live: 'not-probed',
		liveNote: 'needs a SECOND token with a different grant set, and its success half creates a project outside the throwaway one',
		emulator: false,
		emulatorNote: 'the double enforces no scope at all — its one bearer opens everything',
	},
	{
		id: 'integration-token-reads-its-own-capabilities',
		section: SECTION_TOKEN_CAPABILITIES,
		request: { method: 'GET', path: '/client/{clientId}/integration-token/{tokenId}' },
		expect: { status: 200 },
		live: 'not-probed',
		liveNote: 'needs a minted integration token, an account-level credential a test must not create',
		emulator: false,
		emulatorNote: 'the double mints a label and has no read-back route for it',
	},
	{
		id: 'postgres-tls-is-per-service-type',
		section: SECTION_POSTGRES_TLS,
		request: { method: 'GET', path: '/service-stack/{serviceId}' },
		expect: { status: 200 },
		live: 'not-probed',
		liveNote: "not an API fact: it needs a PostgreSQL service and a client inside the project's VXLAN",
		emulator: false,
		emulatorNote: 'the double serves no database',
	},
]

// ── the runner ──────────────────────────────────────────────────────────────────

export type FactFetch = (
	url: string,
	init?: { method?: string; headers?: Record<string, string>; body?: string | ArrayBuffer; signal?: AbortSignal },
) => Promise<Response>

/** Everything a row needs to reach an API — the emulator handler and a real account differ only here. */
export interface FactTransport {
	/** API base without a trailing slash. */
	baseUrl: string
	/** Bearer for every call. NEVER logged and never put in a failure message. */
	token: string
	fetch: FactFetch
	/** How the runner waits between process polls. */
	sleep: (ms: number) => Promise<void>
	signal: AbortSignal
}

/** Named values the rows substitute. Captures write into it, so running the rows in order provisions them. */
export type FactContext = Map<string, string>

/** A probe the generic runner cannot express. It gets the same transport, so it is the same code path. */
export type FactScript = (input: { transport: FactTransport; context: FactContext; fact: PlatformFact }) => Promise<void>

/** How long a row's own process poll may take. Generous: an import's `stack.create` runs ~15 s per service. */
const PROCESS_POLL_INTERVAL_MS = 2_000
const PROCESS_POLL_ATTEMPTS = 90
const PROCESS_TERMINAL = new Set(['FINISHED', 'FAILED', 'CANCELED'])

export class PlatformFactError extends Error {
	constructor(readonly factId: string, readonly section: string, detail: string) {
		super(`zerops platform fact ${factId} (${section}): ${detail}`)
		this.name = 'PlatformFactError'
	}
}

/** Fill `{name}` holes from the context. An unknown name is an error, never an empty string. */
export const substitute = (template: string, context: FactContext): string =>
	template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => {
		const value = context.get(name)
		if (value === undefined) {
			throw new Error(`platform-facts: no value for {${name}}`)
		}
		return value
	})

const substituteBody = (value: unknown, context: FactContext): unknown => {
	if (typeof value === 'string') return substitute(value, context)
	if (Array.isArray(value)) return value.map((entry) => substituteBody(entry, context))
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substituteBody(entry, context)]))
	}
	return value
}

const SEGMENT = /^([A-Za-z0-9_]+)(?:\[(\*|[A-Za-z0-9_]+=[^\]]*)\])?$/

const member = (value: unknown, key: string): unknown =>
	typeof value === 'object' && value !== null && key in value ? Reflect.get(value, key) : undefined

/**
 * Resolve a dotted path to every value it matches.
 *
 * Two bracket forms, which is all the rows need: `name[*]` walks every element of an array, and
 * `name[field=value]` selects the elements of an array whose `field` equals `value`.
 */
export const resolvePath = (value: unknown, path: string): unknown[] => {
	let current: unknown[] = [value]
	for (const segment of path.split('.')) {
		const parsed = SEGMENT.exec(segment)
		if (parsed === null) {
			throw new Error(`platform-facts: unreadable path segment \`${segment}\``)
		}
		const name = parsed[1] ?? ''
		const filter = parsed[2]
		const next: unknown[] = []
		for (const entry of current) {
			const found = member(entry, name)
			if (filter === undefined) {
				if (found !== undefined) next.push(found)
				continue
			}
			if (!Array.isArray(found)) continue
			if (filter === '*') {
				next.push(...found)
				continue
			}
			const separator = filter.indexOf('=')
			const field = filter.slice(0, separator)
			const wanted = filter.slice(separator + 1)
			next.push(...found.filter((item) => member(item, field) === wanted))
		}
		current = next
	}
	return current
}

const single = (value: unknown, path: string): unknown => {
	const found = resolvePath(value, path)
	return found.length === 0 ? undefined : found[0]
}

const render = (value: unknown): string => (value === undefined ? 'absent' : JSON.stringify(value).slice(0, 120))

const checkField = (found: unknown, check: FactFieldCheck, context: FactContext): string | null => {
	switch (check.kind) {
		case 'string':
			return typeof found === 'string' ? null : `expected a string, found ${render(found)}`
		case 'nonEmptyString':
			return typeof found === 'string' && found !== '' ? null : `expected a non-empty string, found ${render(found)}`
		case 'presentUnrendered':
			// Deliberately says nothing about the value: this check exists for fields that carry a credential.
			return typeof found === 'string' ? null : 'expected a string; the value is not rendered because it may be a credential'
		case 'lengthEquals':
			return Array.isArray(found) && found.length === check.length
				? null
				: `expected an array of ${check.length}, found ${Array.isArray(found) ? `${found.length}` : render(found)}`
		case 'equals': {
			const wanted = substitute(check.value, context)
			return found === wanted ? null : `expected ${JSON.stringify(wanted)}, found ${render(found)}`
		}
		case 'oneOf':
			return check.values.some((value) => value === found) ? null : `expected one of ${check.values.join(', ')}, found ${render(found)}`
		case 'boolean':
			return found === check.value ? null : `expected ${String(check.value)}, found ${render(found)}`
		case 'array':
			return Array.isArray(found) ? null : `expected an array, found ${render(found)}`
		case 'emptyArray':
			return Array.isArray(found) && found.length === 0 ? null : `expected an empty array, found ${render(found)}`
		case 'nonEmptyArray':
			return Array.isArray(found) && found.length > 0 ? null : `expected a non-empty array, found ${render(found)}`
		case 'absent':
			return found === undefined ? null : `expected the field to be absent, found ${render(found)}`
	}
}

export interface StepOutcome {
	status: number
	body: unknown
}

/** One authenticated call. Exported so a scripted probe reaches the API the same way a row does. */
export const callApi = async (transport: FactTransport, method: FactMethod, path: string, body?: unknown): Promise<StepOutcome> => {
	const headers: Record<string, string> = { authorization: `Bearer ${transport.token}`, accept: 'application/json' }
	if (body !== undefined) headers['content-type'] = 'application/json'
	const response = await transport.fetch(`${transport.baseUrl}${path}`, {
		method,
		headers,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: transport.signal,
	})
	let payload: unknown = null
	try {
		payload = await response.json()
	} catch {
		payload = null
	}
	return { status: response.status, body: payload }
}

/** Poll one process to a terminal status. The runner's own loop, so both consumers wait the same way. */
export const awaitProcessTerminal = async (transport: FactTransport, processId: string): Promise<void> => {
	for (let attempt = 0;; attempt += 1) {
		const outcome = await callApi(transport, 'GET', `/process/${processId}`, undefined)
		const status = single(outcome.body, 'status')
		if (typeof status === 'string' && PROCESS_TERMINAL.has(status)) {
			if (status !== 'FINISHED') {
				throw new Error(`platform-facts: process ${processId} finished as ${status}`)
			}
			return
		}
		if (attempt >= PROCESS_POLL_ATTEMPTS) {
			throw new Error(`platform-facts: process ${processId} did not finish in time`)
		}
		await transport.sleep(PROCESS_POLL_INTERVAL_MS)
	}
}

const assertExpectation = (fact: PlatformFact, label: string, outcome: StepOutcome, expect: FactExpectation, context: FactContext): void => {
	if (outcome.status !== expect.status) {
		const code = single(outcome.body, 'error.code')
		throw new PlatformFactError(
			fact.id,
			fact.section,
			`${label} answered ${outcome.status}${typeof code === 'string' ? ` ${code}` : ''}, expected ${expect.status}`,
		)
	}
	if (expect.code !== undefined) {
		const code = single(outcome.body, 'error.code')
		if (code !== expect.code) {
			throw new PlatformFactError(fact.id, fact.section, `${label} answered error code ${render(code)}, expected ${expect.code}`)
		}
	}
	if (expect.messageContains !== undefined) {
		const message = single(outcome.body, 'error.message')
		if (typeof message !== 'string' || !message.includes(expect.messageContains)) {
			throw new PlatformFactError(
				fact.id,
				fact.section,
				`${label} answered a message that does not contain ${JSON.stringify(expect.messageContains)}`,
			)
		}
	}
	for (const [path, check] of Object.entries(expect.bodyShape ?? {})) {
		const resolved = substitute(path, context)
		const failure = checkField(single(outcome.body, resolved), check, context)
		if (failure !== null) {
			throw new PlatformFactError(fact.id, fact.section, `${label} field \`${resolved}\`: ${failure}`)
		}
	}
}

const runStep = async (
	transport: FactTransport,
	fact: PlatformFact,
	label: string,
	step: FactStep,
	context: FactContext,
): Promise<void> => {
	const path = substitute(step.path, context)
	const outcome = await callApi(transport, step.method, path, step.body === undefined ? undefined : substituteBody(step.body, context))
	if (step.expect !== undefined) {
		assertExpectation(fact, `${label} ${step.method} ${path}`, outcome, step.expect, context)
	}
	captureInto(fact, step.capture, outcome, context)
	await awaitProcesses(transport, step.awaitProcess, outcome, context)
}

const captureInto = (
	fact: PlatformFact,
	capture: Readonly<Record<string, string>> | undefined,
	outcome: StepOutcome,
	context: FactContext,
): void => {
	for (const [name, path] of Object.entries(capture ?? {})) {
		const found = single(outcome.body, substitute(path, context))
		if (typeof found !== 'string' || found === '') {
			throw new PlatformFactError(fact.id, fact.section, `nothing to capture as {${name}} at \`${path}\``)
		}
		context.set(name, found)
	}
}

const awaitProcesses = async (
	transport: FactTransport,
	path: string | undefined,
	outcome: StepOutcome,
	context: FactContext,
): Promise<void> => {
	if (path === undefined) return
	for (const id of resolvePath(outcome.body, substitute(path, context))) {
		if (typeof id === 'string' && id !== '') {
			await awaitProcessTerminal(transport, id)
		}
	}
}

/**
 * Run ONE row against ONE transport. Throws `PlatformFactError` naming the row, the section it came from
 * and what differed; a setup step that fails throws too, labelled as setup so it is never read as the fact.
 */
export const runFact = async (input: {
	transport: FactTransport
	fact: PlatformFact
	context: FactContext
	scripts?: Readonly<Record<string, FactScript>>
}): Promise<void> => {
	const { transport, fact, context } = input
	if (fact.script !== undefined) {
		const script = input.scripts?.[fact.script]
		if (script === undefined) {
			throw new PlatformFactError(fact.id, fact.section, `needs the scripted probe \`${fact.script}\`, which this consumer did not supply`)
		}
		await script({ transport, context, fact })
		return
	}
	for (const [index, step] of (fact.setup ?? []).entries()) {
		await runStep(transport, fact, `setup ${index + 1}:`, step, context)
	}
	const path = substitute(fact.request.path, context)
	const outcome = await callApi(
		transport,
		fact.request.method,
		path,
		fact.request.body === undefined ? undefined : substituteBody(fact.request.body, context),
	)
	assertExpectation(fact, `${fact.request.method} ${path}`, outcome, fact.expect, context)
	captureInto(fact, fact.capture, outcome, context)
	await awaitProcesses(transport, fact.awaitProcess, outcome, context)
	for (const [index, step] of (fact.then ?? []).entries()) {
		await runStep(transport, fact, `then ${index + 1}:`, step, context)
	}
}

/**
 * A path no live run may DELETE: the account gives the suite a project, and deleting one would take
 * everything in it with it. `project-delete-is-a-process` keeps the request shape as documentation, and this
 * is what stops a later edit from flipping it to a probe and running it.
 */
const PROJECT_PATH = /^\/project\/[^/]+$/

/**
 * Refuse a row the live consumer must never execute, before anything reaches the transport. Defensive on
 * purpose: the table is data, and data is easy to change without noticing what it now authorises.
 */
export const assertLiveRowIsSafe = (fact: PlatformFact): void => {
	const steps = [...(fact.setup ?? []), { method: fact.request.method, path: fact.request.path }, ...(fact.then ?? [])]
	const destructive = steps.find((step) => step.method === 'DELETE' && PROJECT_PATH.test(step.path))
	if (destructive !== undefined) {
		throw new PlatformFactError(fact.id, fact.section, `refused: a live run must never DELETE ${destructive.path}`)
	}
}

/** Rows one consumer must run. `'emulator'` takes the modelled ones, `'live'` everything it can probe. */
export const factsFor = (side: 'emulator' | 'live', options: { slow?: boolean } = {}): readonly PlatformFact[] =>
	PLATFORM_FACTS.filter((fact) =>
		side === 'emulator'
			? fact.emulator
			: fact.live !== 'not-probed' && (fact.live !== 'build' || options.slow === true)
	)
