// `boot(app, { environment, iam })`: called once, by the generated entrypoint through its runtime adapter, after the
// adapter captured the framework's variables and scrubbed them from the process. It compiles the contract, binds
// every handler to its endpoint and refuses to start when anything declared cannot be served.

import { IamMembership } from '@fabrika/auth'
import {
	compileEndpointTable,
	type ContractArtifact,
	contractDigest,
	type CredentialedEndpoint,
	endpointAppDirectory,
	endpointDigest,
	endpointDirectory,
	endpointMembers,
	type EndpointRow,
	FABRIKA_CONTRACT_DIGEST,
	FABRIKA_IAM_APP_ID,
	FABRIKA_PROXY_SECRET,
	type IamMembershipRpc,
	isLoopbackHost,
	type Jwks,
	parseAppEnvironmentId,
} from '@fabrika/auth-core'
import type { Database } from '@fabrika/db'
import type { CapabilityAuthority } from '@fabrika/db/capability'
import { bindScopedDatabase, type DataAccess, dataAccessOf, type FrameworkTables, frameworkTablesOf, isScopedDatabase } from '@fabrika/db/framework'
import type { DataKind } from '@fabrika/db/tables'
import type { EmailProviderRegistry } from '@fabrika/email'
import { builtinEmailProviders } from '@fabrika/email/providers'
import { TokenVerifier } from '@fabrika/jwks'
import type { FileObjectStore } from '@fabrika/platform'
import { compileContract } from '../contract/compile'
import { exportDescription } from '../contract/connect'
import { isProcedure, type ProcedureDeclaration, type ProcedureTreeDeclaration, SURFACE_SECTIONS } from '../contract/declaration'
import { exportBase, spaPrefixRowId } from '../contract/defaults'
import type { AnyContract, Schema } from '../contract/define'
import { kitOriginOf } from '../contract/handled'
import { schemaFromShape } from '../contract/schema-from-shape'
import type { RequestExecutionContext } from '../fetch'
import { FILE_SWEEP_JOB, FILE_SWEEP_SCHEDULE, FILE_SWEEP_TIMEOUT_MS, storedFileKinds } from '../files/kinds'
import { FILE_SCAN_JOB, FILE_SCAN_SCHEDULE, type FileScanner, SCAN_LIMITS } from '../files/scan'
import { type MailStandIn, resolveMailTransports } from '../jobs/mail'
import { logReporter, type OperationsReporter, operationsReporter, operationsSettings, type ReportSource } from '../jobs/report'
import { bindJobs, type ContractJobs, type HandlerErrorSink } from '../jobs/runner'
import { environmentScrubber } from '../jobs/scrub'
import { browserConfigs } from './browser-config'
import { createCapabilityIssuer, requestIsReadOnly } from './capability'
import type { ChallengeFetch } from './challenge'
import { type ConnectFetch, wireImports } from './connect'
import {
	ContractRuntime,
	type Facilities,
	NO_FACILITIES,
	type ProcedureQuery,
	proxySecretDigest,
	type ServedEndpoint,
	type ServedSite,
	type SpaAssets,
} from './dispatch'
import { installEgressGuard, platformCall, platformFacility } from './egress'
import type { CapturedEnvironment } from './environment'
import { FailureReports } from './failures'
import { applicationPolicy } from './headers'
import type { ContractDatabase, ContractImplementation, ImplementationDatabase } from './implement'
import { approvedDeclaration, approvedReach, isSiteHandler, type SiteDeclaration } from './invocation'
import type { ReadDirectory } from './membership'
import { type AdmissionOptions, InFlightShare, type ProcedureAdmission, procedureAdmission, publicShareOf } from './public'
import { readTokenKeys, type RuntimePurpose, SignedTokens } from './tokens'
import { appUrl, readAppOrigin } from './urls'
import type { BindableWebhook } from './webhook'
import { type WorkloadCredential, workloadCredentials, workloadSite, type WorkloadTokenSource } from './workload'

/** Where the token verifier gets IAM's public keys: the IAM binding on Cloudflare, the issuer's JWKS elsewhere. */
export interface IamKeySource {
	getJwks(): Promise<Jwks>
}

export interface BootOptions {
	/** The variables `captureEnvironment` took before the application's modules loaded. */
	readonly environment: CapturedEnvironment
	readonly iam: IamKeySource
	/** Serves the SPA mounts. Without it, a contract that declares one does not boot. */
	readonly assets?: SpaAssets
	/** The application's Postgres connection, which the Bun adapter opens. Without it, an application on `@fabrika/db` does not boot. */
	readonly database?: Database
	/**
	 * The proxy authenticates itself with `FABRIKA_PROXY_SECRET`, and the application does not boot without it. The Bun
	 * adapter sets it: on Zerops a namespace is one private network. On Cloudflare the service binding is the
	 * authenticated hop (ADR-0022 rule 1). A secret that is set is checked either way.
	 */
	readonly requireProxySecret?: boolean
	/** The object storage of the stored files, which the Bun adapter opens. Without it, a contract with file kinds does not boot. */
	readonly files?: FileObjectStore
	/**
	 * The malware scanner of the scan job of `scan: true` file kinds, which the Bun adapter supplies to a job run
	 * (`clamscanScanner`). Without it the scan job leaves every quarantined file quarantined and reports.
	 */
	readonly scanner?: FileScanner
	/**
	 * IAM's membership operations: the IAM binding on Cloudflare, `HttpIamRpc` elsewhere. Without it, a contract that
	 * creates scopes, manages members or issues share links does not boot.
	 */
	readonly membership?: IamMembershipRpc
	/**
	 * Cloudflare service bindings to the owners' proxy Workers, by binding name (`FABRIKA_CONNECT_<IMPORT>`). An import
	 * without one calls its owner with `fetch`.
	 */
	readonly connectBindings?: Readonly<Record<string, ConnectFetch>>
	/**
	 * Where a job or a webhook exchanges its key for a token: IAM's public token exchange on Bun. Without it, a contract
	 * with a job or a webhook does not boot.
	 */
	readonly workloadTokens?: WorkloadTokenSource
	/** What posts a report to Operations' ingest; `fetch` by default. */
	readonly operationsFetch?: (request: Request) => Promise<Response>
	/** What asks a public procedure's challenge provider to verify a token; `fetch` by default. */
	readonly challengeFetch?: ChallengeFetch
	/**
	 * The developer's own machine only (`fabrika app dev`): the token a challenge admits more than once, which
	 * Turnstile's always-passing test widget hands out for every call. Every other token stays single use.
	 */
	readonly repeatableChallengeToken?: string
	/**
	 * The developer's own machine only (`fabrika app dev`): what a job's handler threw, which every log of a deployed
	 * application withholds because it may carry a credential.
	 */
	readonly revealHandlerErrors?: HandlerErrorSink
	/** The providers `FABRIKA_EMAIL_PROVIDER` may name for the jobs that declare `mailer: 'installation'`; the built-in ones by default. */
	readonly emailProviders?: EmailProviderRegistry
	/**
	 * Providers added to `emailProviders` only in a local composition (a loopback `FABRIKA_IAM_ISSUER`); anywhere else
	 * `FABRIKA_EMAIL_PROVIDER` naming one is refused like any unknown provider. On a name both hold, `emailProviders` wins.
	 */
	readonly localEmailProviders?: EmailProviderRegistry
	/**
	 * The test kit's stand-in for every mailer job, or `'none'` for an installation without mail; boot then reads neither
	 * `FABRIKA_EMAIL_*` nor `serve`'s `mail`.
	 */
	readonly mailStandIn?: MailStandIn
	/** The connections the application's pool holds: a quarter of them, at least one, is the public procedures' share. */
	readonly connections?: number
	/**
	 * `'vouched'` where the proxy's `X-Fabrika-Client-Ip` is the visitor's own address, so `ctx.client.ip` reads it. A
	 * runtime behind a balancer whose range the platform does not trust (Zerops, until it does) leaves it unset: the ip is
	 * then `null`.
	 */
	readonly clientAddress?: 'vouched'
}

/** The pool size a runtime adapter that names none is assumed to have: the Bun adapter's default. */
const DEFAULT_CONNECTIONS = 10

export interface ContractApp {
	/** `exec` keeps a failure's report to Operations alive past the response (a Worker's `waitUntil`). */
	fetch(request: Request, exec?: RequestExecutionContext): Promise<Response>
	/** The contract's `c.cron` jobs; `fabrika job run <name>` runs one. */
	readonly jobs: ContractJobs
	/** Aborts every kicked run in flight; a later kick starts none; the schedule recovers their work. */
	stopKicks(): void
}

/** Everything that stops a contract application from starting, with where it is and what to do. */
export class BootError extends Error {
	override readonly name = 'BootError'
	readonly problems: readonly string[]

	constructor(problems: readonly string[]) {
		super(`the application does not boot:\n- ${problems.join('\n- ')}`)
		this.problems = problems
	}
}

interface FrameworkVariables {
	/** The token audience: this application's IAM id in this environment, `<app>@<env>`. */
	readonly iamAppId: string
	readonly issuer: string
	readonly operationsOrigin: string | null
}

function httpOrigin(name: string, raw: unknown, problems: string[]): string | null {
	if (typeof raw !== 'string' || raw.trim() === '') {
		problems.push(`${name} is not set; the platform writes it into every deploy`)
		return null
	}
	try {
		const url = new URL(raw.trim())
		if (url.protocol === 'https:' || url.protocol === 'http:') {
			return url.origin
		}
	} catch {
		// Reported below, without the value: it may carry a key.
	}
	problems.push(`${name} is not an http(s) URL`)
	return null
}

function readFramework(framework: Readonly<Record<string, string>>, contractApp: string, problems: string[]): FrameworkVariables {
	const iamAppId = framework[FABRIKA_IAM_APP_ID]?.trim() ?? ''
	const parsed = parseAppEnvironmentId(iamAppId)
	if (iamAppId === '') {
		problems.push(`${FABRIKA_IAM_APP_ID} is not set; it is the audience every token must carry, <app>@<env>`)
	} else if (parsed === null) {
		problems.push(`${FABRIKA_IAM_APP_ID} '${iamAppId}' is not an application environment id (allowed: <app>@<env>)`)
	} else if (parsed.app !== contractApp) {
		problems.push(`${FABRIKA_IAM_APP_ID} names the application '${parsed.app}', but the contract declares '${contractApp}'`)
	}
	const issuer = httpOrigin('FABRIKA_IAM_ISSUER', framework['FABRIKA_IAM_ISSUER'], problems)
	const dsn = framework['FABRIKA_OPERATIONS_DSN']
	const operationsOrigin = dsn === undefined ? null : httpOrigin('FABRIKA_OPERATIONS_DSN', dsn, problems)
	return { iamAppId, issuer: issuer ?? '', operationsOrigin }
}

/** The deploy was approved with one contract; this build must be that contract, or it does not start (ADR-0022 rule 5). */
function checkContractDigest(framework: Readonly<Record<string, string>>, artifact: ContractArtifact, problems: string[]): void {
	const expected = framework[FABRIKA_CONTRACT_DIGEST]?.trim() ?? ''
	const actual = contractDigest(artifact)
	if (expected === '') {
		problems.push(`${FABRIKA_CONTRACT_DIGEST} is not set; it is the digest of the contract the deploy was approved with`)
	} else if (expected !== actual) {
		problems.push(
			`the contract's digest is ${actual}, but ${FABRIKA_CONTRACT_DIGEST} is ${expected}: this build is not the contract the deploy was approved with`,
		)
	}
}

/** Every dimension's containers, nearest first (`note → [workspace, organization]`); `buildArtifact` refuses a cycle. */
function containersOf(artifact: ContractArtifact): ReadonlyMap<string, readonly string[]> {
	const containers = new Map<string, readonly string[]>()
	for (const dimension of Object.keys(artifact.dimensions)) {
		const chain: string[] = []
		let next = artifact.dimensions[dimension]?.in ?? null
		while (next !== null && !chain.includes(next)) {
			chain.push(next)
			next = artifact.dimensions[next]?.in ?? null
		}
		containers.set(dimension, chain)
	}
	return containers
}

/** The shortest secret accepted; Control generates 32 random bytes. */
const MIN_PROXY_SECRET_LENGTH = 32

/** The digest of the proxy secret the application compares every request's with, or `null` when it has none. */
function readProxySecret(framework: Readonly<Record<string, string>>, required: boolean, problems: string[]): Uint8Array | null {
	const secret = framework[FABRIKA_PROXY_SECRET] ?? ''
	if (secret === '') {
		if (required) {
			problems.push(`${FABRIKA_PROXY_SECRET} is not set; the proxy authenticates itself to the application with it`)
		}
		return null
	}
	if (secret.length < MIN_PROXY_SECRET_LENGTH) {
		problems.push(`${FABRIKA_PROXY_SECRET} is shorter than ${MIN_PROXY_SECRET_LENGTH} characters`)
		return null
	}
	return proxySecretDigest(secret)
}

/** What this version cannot serve yet; a contract that declares it does not boot rather than answer nothing. */
function unservable(
	artifact: ContractArtifact,
	assets: SpaAssets | undefined,
	owned: ReadonlySet<string>,
	containers: ReadonlyMap<string, readonly string[]>,
	problems: string[],
): void {
	for (const [name, mount] of Object.entries(artifact.mounts)) {
		if ((mount.kind === 'spa' || mount.kind === 'link') && assets === undefined) {
			problems.push(`mount '${name}' serves an SPA, and the runtime adapter supplies no asset server`)
		}
		if (mount.kind === 'link' && !owned.has(mount.dimension)) {
			// Every link request re-reads where the object lies; without the table that records it, nothing could.
			problems.push(`link mount '${name}' shares a '${mount.dimension}', but no table in src/db/tables.ts owns that dimension to locate it`)
		}
	}
	for (const row of artifact.endpoints) {
		if (row.requirement?.kind !== 'action') {
			continue
		}
		const { access } = row.requirement
		if (access.form === 'creates' || access.form === 'app') {
			continue
		}
		if (access.form === 'on' && access.from === null) {
			continue
		}
		if (access.form === 'on' && !owned.has(access.dimension)) {
			problems.push(`'${row.id}' acts on a '${access.dimension}', but no table in src/db/tables.ts owns that dimension to locate it`)
		} else {
			// A grant on a container reaches a value only through the table that records which container holds it.
			const unlocated = [access.dimension, ...(containers.get(access.dimension) ?? [])].find((dimension) =>
				(artifact.dimensions[dimension]?.in ?? null) !== null && !owned.has(dimension)
			)
			if (unlocated !== undefined) {
				problems.push(
					`'${row.id}' reaches a '${access.dimension}'; '${unlocated}' lies in '${
						artifact.dimensions[unlocated]?.in
					}', but no table in src/db/tables.ts owns '${unlocated}' to locate it`,
				)
			}
		}
	}
}

/** Own properties only, so a handler tree can never name a prototype member. */
function childAt(node: unknown, key: string): unknown {
	return typeof node === 'object' && node !== null && Object.hasOwn(node, key) ? Reflect.get(node, key) : undefined
}

interface DeclaredProcedure {
	readonly id: string
	readonly path: readonly string[]
	readonly procedure: ProcedureDeclaration<Schema, unknown>
}

function declaredProcedures(mount: string, tree: ProcedureTreeDeclaration<Schema, unknown>, path: readonly string[] = []): DeclaredProcedure[] {
	return Object.entries(tree).flatMap(([name, node]) => {
		const at = [...path, name]
		return isProcedure(node) ? [{ id: [mount, ...at].join('.'), path: [mount, ...at], procedure: node }] : declaredProcedures(mount, node, at)
	})
}

/** Every function in the tree must be a declared procedure's handler, even when a cast defeated the handler types. */
function undeclaredHandlers(node: unknown, declared: ReadonlySet<string>, path: readonly string[], problems: string[]): void {
	const id = path.join('.')
	if (typeof node === 'function' || isSiteHandler(node)) {
		if (!declared.has(id)) {
			problems.push(`handler '${id}' is not in the contract; declare the endpoint in fabrika.contract.ts first`)
		}
		return
	}
	if (typeof node !== 'object' || node === null) {
		problems.push(`handler '${id || 'handlers'}' is not a function or a group of handlers`)
		return
	}
	for (const key of Object.keys(node)) {
		undeclaredHandlers(childAt(node, key), declared, [...path, key], problems)
	}
}

interface BoundDatabase {
	readonly database: ContractDatabase
	/** The framework's own writes; only a `scoped(tables)` layer has them. */
	readonly framework: FrameworkTables | null
	/** The mini-ORM behind a staged-kit site's `ctx.db`; only a `scoped(tables)` layer has it. */
	readonly data: DataAccess | null
}

/**
 * The database `dispatch` reads. A `scoped(tables)` result is bound here, once, to the adapter's connection and the
 * authority that binds capabilities to requests; the application never receives either, nor the locator.
 */
function contractDatabase(
	database: ImplementationDatabase | null,
	connection: Database | undefined,
	capabilities: CapabilityAuthority,
	problems: string[],
): BoundDatabase | null {
	if (database === null) {
		return null
	}
	if (!isScopedDatabase(database)) {
		if ('locate' in database) {
			return { database, framework: null, data: null }
		}
		problems.push('serve(contract, { database }) takes the scoped(tables) result of @fabrika/db itself, not a copy or a wrapper of it')
		return null
	}
	if (connection === undefined) {
		problems.push('the application uses @fabrika/db, which runs on Bun with Postgres, and the runtime adapter supplies no database connection')
		return null
	}
	try {
		const locate = bindScopedDatabase(database, { database: connection, capabilities, readOnly: requestIsReadOnly })
		return { database: { tables: database.tables, locate }, framework: frameworkTablesOf(database), data: dataAccessOf(database) }
	} catch {
		problems.push('the data layer was bound before boot; only the framework binds it, so remove @fabrika/db/framework from the application')
		return null
	}
}

/**
 * A handler tree leaf, bound. `declaration` is the reach the approved artifact gives the site, or `null` for a
 * `defineContract` contract, whose reach is its imports' `usedBy` and its link mounts; `site` whether the leaf is a
 * staged-kit site, which reaches data through `ctx.db`.
 */
interface BoundHandler {
	readonly handler: (args: { readonly input: unknown; readonly ctx: object }) => unknown
	readonly declaration: SiteDeclaration | null
	readonly site: boolean
}

/**
 * A leaf of `site` (an endpoint id). Its reach is the approved artifact's, whatever the leaf is: a staged-kit
 * contract's artifact holds every site's declaration (none when the site declares none), and a site leaf that
 * declares otherwise does not boot.
 */
function boundHandler(
	node: unknown,
	site: string,
	where: string,
	kind: DataKind,
	artifact: ContractArtifact,
	problems: string[],
): BoundHandler | null {
	if (isSiteHandler(node)) {
		const leaf = node
		return {
			handler: (args) => Reflect.apply(leaf.handler, undefined, [args]),
			declaration: approvedDeclaration(where, site, leaf.declared, kind, artifact, problems),
			site: true,
		}
	}
	if (typeof node === 'function') {
		return {
			handler: (args) => Reflect.apply(node, undefined, [args]),
			declaration: artifact.declared === undefined ? null : approvedReach(site, artifact),
			site: false,
		}
	}
	return null
}

/** The origins a staged-kit site's handler reaches, a kit without tables included; nothing for a bare handler. */
function egressOf(bound: BoundHandler): { readonly egress?: readonly string[] } {
	return !bound.site || bound.declaration === null ? {} : { egress: bound.declaration.egress }
}

/** A staged-kit contract's endpoint gets `ctx.links` only for the link mount it declares it `issues`. */
function siteFacilities(facilities: Facilities, declaration: SiteDeclaration | null): Facilities {
	if (declaration === null) {
		return facilities
	}
	const links = facilities.links.filter((link) => link.name === declaration.issues)
	return links.length === facilities.links.length ? facilities : Object.freeze({ members: facilities.members, links: Object.freeze(links) })
}

/** A staged-kit contract's endpoint gets `ctx.connect` only for the connectors it declares. */
function siteConnect<W extends { readonly name: string }>(
	wires: readonly W[] | undefined,
	declaration: SiteDeclaration | null,
): readonly W[] | undefined {
	if (declaration === null || wires === undefined) {
		return wires
	}
	const declared = wires.filter((wire) => declaration.connect.includes(wire.name))
	return declared.length === 0 ? undefined : declared
}

/**
 * A kit without tables has no `ctx.db`: its procedures are served as plain handlers with their approved reach, and a
 * site that declares `sql` does not boot, since `ctx.sql` runs on `@fabrika/db`.
 */
function servedWithoutData(endpoints: Map<string, ServedEndpoint>, problems: string[]): void {
	for (const [id, served] of endpoints) {
		if (served.kind !== 'procedure' || served.site === undefined) {
			continue
		}
		if (served.site.declaration.sql !== null) {
			problems.push(`'${id}' declares sql, which runs on @fabrika/db; defineApp(vocabulary, tables) gives an application tables`)
		}
		endpoints.set(id, { ...served, site: undefined })
	}
}

/** The site `dispatch` builds `ctx.db` for: a staged-kit site leaf only, with its approved declaration. */
function servedSite(kind: DataKind, bound: BoundHandler): ServedSite | undefined {
	return !bound.site || bound.declaration === null ? undefined : { kind, declaration: bound.declaration }
}

/** `ctx.members` and `ctx.links` of an endpoint: decided from its access form and the artifact, once. */
function facilitiesOf(artifact: ContractArtifact, row: EndpointRow): Facilities {
	if (row.requirement?.kind !== 'action') {
		return NO_FACILITIES
	}
	const { action, access } = row.requirement
	if (endpointAppDirectory(artifact, row)) {
		return Object.freeze({ members: 'application', links: Object.freeze([]) })
	}
	if ((access.form !== 'in' && access.form !== 'on') || access.from === null) {
		return NO_FACILITIES
	}
	const links = Object.entries(artifact.mounts).flatMap(([name, mount]) =>
		mount.kind === 'link' && mount.dimension === access.dimension && mount.issuedBy === action ? [{ name, prefix: mount.prefix }] : []
	)
	return Object.freeze({ members: endpointMembers(artifact, row) === 'manage' ? 'manage' : readDirectory(artifact, row), links: Object.freeze(links) })
}

/** The member directory the endpoint reads, and whether its dimension shows labels. */
function readDirectory(artifact: ContractArtifact, row: EndpointRow): ReadDirectory | null {
	const directory = endpointDirectory(artifact, row)
	if (directory === null) {
		return null
	}
	const dimension = Object.hasOwn(artifact.dimensions, directory.dimension) ? artifact.dimensions[directory.dimension] : undefined
	return Object.freeze({ ...directory, labels: dimension?.directory === 'labels' })
}

/**
 * Whether serving the endpoint needs IAM: a new scope, a membership change or a share link. A member directory does
 * not: it asks IAM only when the handler calls it, and fails that call alone without a transport.
 */
function asksIam(served: ServedEndpoint): boolean {
	if (served.kind !== 'procedure') {
		return false
	}
	const creates = served.row.requirement.kind === 'action' && served.row.requirement.access.form === 'creates'
	return creates || served.facilities.members === 'manage' || served.facilities.links.length > 0
}

/** A webhook and a procedure's buckets write the framework's own tables, which only `@fabrika/db`'s `scoped(tables)` reaches. */
function frameworkProblems(artifact: ContractArtifact, framework: FrameworkTables | null, problems: string[]): void {
	const counted = Object.entries(artifact.procedures ?? {}).find(([, rules]) => Object.values(rules.rate).some((bucket) => bucket !== null))
	if (counted !== undefined && framework === null) {
		problems.push(
			`procedure '${counted[0]}' counts its calls in buckets, which live in @fabrika/db: pass serve(contract, { database: scoped(tables) })`,
		)
	}
	for (const [name, mount] of Object.entries(artifact.mounts)) {
		if (mount.kind === 'webhook' && framework === null) {
			problems.push(`mount '${name}' is a webhook, which writes through @fabrika/db: pass serve(contract, { database: scoped(tables) })`)
		}
	}
}

function isCredentialed(row: EndpointRow | undefined): row is CredentialedEndpoint {
	return row !== undefined && row.requirement !== null
}

/** A POST procedure's `http.query`, as the field its served endpoint carries: parsed by the approved shape. */
function queryOf(id: string, artifact: ContractArtifact): { readonly query?: ProcedureQuery } {
	const shape = artifact.procedures !== undefined && Object.hasOwn(artifact.procedures, id) ? artifact.procedures[id]?.query : undefined
	return shape === undefined ? {} : { query: { schema: schemaFromShape(shape), shape } }
}

/** A procedure's admission, as the field its served endpoint carries; none after a problem. */
function admissionOf(id: string, artifact: ContractArtifact, options: BootOptions, problems: string[]): { readonly admission?: ProcedureAdmission } {
	const admission = procedureAdmission(id, artifact, admissionOptions(options), problems)
	return admission === null ? {} : { admission }
}

function admissionOptions(options: BootOptions): AdmissionOptions {
	return {
		application: options.environment.application,
		...(options.challengeFetch === undefined ? {} : { challengeFetch: options.challengeFetch }),
		...(options.repeatableChallengeToken === undefined ? {} : { repeatableChallengeToken: options.repeatableChallengeToken }),
	}
}

/**
 * A public procedure: its staged-kit handler, its key, and its admission. Without the key's credential (no token
 * exchange, or the variable unset) `workloadCredentials` already reported why.
 */
function publicEndpoint(
	row: EndpointRow,
	procedure: ProcedureDeclaration<Schema, unknown>,
	bound: BoundHandler | null,
	artifact: ContractArtifact,
	workloads: ReadonlyMap<string, WorkloadCredential>,
	options: BootOptions,
	problems: string[],
): ServedEndpoint | null {
	const where = `public procedure '${row.id}'`
	const site = bound === null ? undefined : servedSite(procedure.type, bound)
	if (bound === null || site === undefined) {
		problems.push(`${where} has no handler of the staged kit; declare it with .handle(…) beside its declaration`)
		return null
	}
	const actions = artifact.declared?.[row.id]?.actions ?? []
	const credential = workloads.get(workloadSite('public', row.id))
	const admission = procedureAdmission(row.id, artifact, admissionOptions(options), problems)
	if (credential === undefined || admission === null) {
		return null
	}
	return {
		kind: 'public',
		row,
		input: procedure.input,
		output: procedure.output,
		handler: bound.handler,
		actions,
		credential,
		admission,
		site,
		...queryOf(row.id, artifact),
	}
}

/** The webhook a procedure binds (`binds`), as the approved artifact declares it. */
function bindsOf(
	id: string,
	declaration: SiteDeclaration | null,
	artifact: ContractArtifact,
	problems: string[],
): { readonly binds?: BindableWebhook } {
	const name = declaration?.binds ?? null
	if (name === null) {
		return {}
	}
	const mount = Object.hasOwn(artifact.mounts, name) ? artifact.mounts[name] : undefined
	if (mount?.kind !== 'webhook') {
		problems.push(`procedure '${id}' binds '${name}', which is not a webhook of the contract`)
		return {}
	}
	return { binds: { name, path: mount.path, scheme: mount.scheme, boundTo: mount.boundTo } }
}

/** Each approved token purpose with the claims schema the application declared for it. */
function runtimePurposes(contract: AnyContract, artifact: ContractArtifact): ReadonlyMap<string, RuntimePurpose> {
	const declared = contract.surface.tokens ?? {}
	const purposes = new Map<string, RuntimePurpose>()
	for (const [purpose, approved] of Object.entries(artifact.tokens ?? {})) {
		const own = Object.hasOwn(declared, purpose) ? declared[purpose] : undefined
		if (own !== undefined) {
			purposes.set(purpose, { claims: own.claims, maxDays: approved.maxDays })
		}
	}
	return purposes
}

export function boot(app: ContractImplementation, options: BootOptions): ContractApp {
	const problems: string[] = []
	installEgressGuard()
	// What a handler reaches through these is the platform's own request, which no site's egress covers.
	const objects = options.files === undefined ? undefined : platformFacility(options.files)
	const membershipRpc = options.membership === undefined ? undefined : platformFacility(options.membership)
	const workloadTokens = options.workloadTokens === undefined ? undefined : platformFacility(options.workloadTokens)
	const variables = readFramework(options.environment.framework, app.contract.vocabulary.app, problems)
	const artifact = compileContract(app.contract, app.database?.tables ?? {})
	checkContractDigest(options.environment.framework, artifact, problems)
	const proxySecret = readProxySecret(options.environment.framework, options.requireProxySecret === true, problems)
	const tokens = new SignedTokens(runtimePurposes(app.contract, artifact), readTokenKeys(options.environment.framework, artifact, problems))
	const origin = readAppOrigin(options.environment.framework, problems)
	const url = appUrl(artifact, origin)
	const operations = operationsSettings(options.environment.framework, problems)
	const scrubber = environmentScrubber(options.environment)
	const reporterFor = (source: ReportSource): OperationsReporter | null =>
		operations === null
			? null
			: operationsReporter({ ...operations, source, scrubber, ...(options.operationsFetch === undefined ? {} : { fetch: options.operationsFetch }) })
	const owned = new Set(Object.values(artifact.tables).flatMap((table) => table.scope.mode === 'dimension' ? [table.scope.dimension] : []))
	const containers = containersOf(artifact)
	unservable(artifact, options.assets, owned, containers, problems)
	// This runtime's own: what another `boot` call mints, application code's included, its stores refuse.
	const issuer = createCapabilityIssuer()
	const fileKinds = storedFileKinds(artifact, app.database, objects, problems)
	const bound = contractDatabase(app.database, options.database, issuer.authority, problems)
	const framework = bound?.framework ?? null
	frameworkProblems(artifact, framework, problems)
	const database = bound?.database ?? null
	const verifier = new TokenVerifier({ getJwks: () => platformCall(() => options.iam.getJwks()), issuer: variables.issuer })
	const workloads = workloadCredentials({
		artifact,
		framework: options.environment.framework,
		audience: variables.iamAppId,
		source: workloadTokens,
		verifier,
	}, problems)
	const connect = wireImports({
		artifact,
		snapshots: app.connect ?? {},
		framework: options.environment.framework,
		bindings: Object.fromEntries(
			Object.entries(options.connectBindings ?? {}).map((
				[name, binding],
			): [string, ConnectFetch] => [name, (request) => platformCall(() => binding(request))]),
		),
		fallback: (request) => platformCall(() => fetch(request)),
	}, problems)
	const configs = browserConfigs(artifact, options.environment, {
		dsn: operations === null ? null : (options.environment.framework['FABRIKA_OPERATIONS_DSN'] ?? '').trim(),
		release: options.environment.framework['FABRIKA_RELEASE']?.trim() || null,
	}, problems)
	// A token of a deployed IAM never carries a loopback issuer, so a deployed application is never local.
	const local = variables.issuer !== '' && isLoopbackHost(new URL(variables.issuer).hostname)
	const providers = options.emailProviders ?? builtinEmailProviders
	const mail = resolveMailTransports({
		artifact,
		framework: options.environment.framework,
		application: options.environment.application,
		own: app.mail,
		standIn: options.mailStandIn,
		registry: local ? { ...options.localEmailProviders, ...providers } : providers,
		keyScope: { issuer: variables.issuer, appId: variables.iamAppId },
		local,
	}, problems)
	if (problems.length > 0) {
		throw new BootError(problems)
	}

	const rows = new Map(artifact.endpoints.map((row) => [row.id, row]))
	const endpoints = new Map<string, ServedEndpoint>()
	const handlers = app.handlers(options.environment.application, { capabilities: issuer.authority })
	const declared = new Set<string>()
	for (const [name, mount] of Object.entries(app.contract.surface)) {
		if (SURFACE_SECTIONS.some((section) => section === name) || typeof mount !== 'object' || !('kind' in mount)) {
			continue
		}
		if (mount.kind === 'health') {
			const row = rows.get(name)
			if (row !== undefined) {
				endpoints.set(name, { kind: 'health', row })
			}
		} else if (mount.kind === 'spa') {
			const row = rows.get(name)
			const config = configs.get(name)
			if (config !== undefined && isCredentialed(row)) {
				endpoints.set(name, { kind: 'spa', row, prefix: mount.prefix, dir: mount.dir, config })
			} else if (config !== undefined && row?.kind === 'public-spa') {
				endpoints.set(name, { kind: 'public-spa', row, prefix: mount.prefix, dir: mount.dir, config })
			}
			const bare = rows.get(spaPrefixRowId(name))
			if (bare !== undefined) {
				endpoints.set(bare.id, { kind: 'spa-prefix', row: bare, prefix: mount.prefix })
			}
		} else if (mount.kind === 'rpc' || mount.kind === 'link') {
			if (mount.kind === 'link') {
				const row = rows.get(name)
				if (row !== undefined) {
					endpoints.set(name, { kind: 'link-spa', row, prefix: mount.prefix, dir: mount.spa })
				}
			}
			for (const { id, path, procedure } of declaredProcedures(name, mount.procedures)) {
				declared.add(id)
				const row = rows.get(id)
				const bound = boundHandler(path.reduce<unknown>(childAt, handlers), id, `procedure '${id}'`, procedure.type, artifact, problems)
				if (row?.kind === 'public') {
					const served = publicEndpoint(row, procedure, bound, artifact, workloads, options, problems)
					if (served !== null) {
						endpoints.set(id, served)
					}
					continue
				}
				if (!isCredentialed(row)) {
					problems.push(`procedure '${id}' has no endpoint row`)
				} else if (bound === null) {
					problems.push(`procedure '${id}' has no handler; add it to handlers`)
				} else {
					endpoints.set(id, {
						kind: 'procedure',
						row,
						input: procedure.input,
						output: procedure.output,
						handler: bound.handler,
						facilities: siteFacilities(facilitiesOf(artifact, row), bound.declaration),
						connect: siteConnect(connect.get(id), bound.declaration),
						site: servedSite(procedure.type, bound),
						...egressOf(bound),
						...bindsOf(id, bound.declaration, artifact, problems),
						...admissionOf(id, artifact, options, problems),
						...queryOf(id, artifact),
					})
				}
			}
		} else if (mount.kind === 'webhook') {
			declared.add(name)
			const row = rows.get(name)
			const bound = boundHandler(childAt(handlers, name), name, `webhook '${name}'`, 'mutation', artifact, problems)
			const credential: WorkloadCredential | undefined = workloads.get(workloadSite('webhook', name))
			const approved = artifact.mounts[name]
			if (row === undefined || bound === null) {
				problems.push(`webhook '${name}' has no handler; add handlers.${name}: ({ input, ctx }) => …`)
			} else if (credential !== undefined && approved?.kind === 'webhook') {
				endpoints.set(name, {
					kind: 'webhook',
					row,
					webhook: name,
					scheme: approved.scheme,
					boundTo: approved.boundTo,
					timeoutMs: approved.timeoutMs,
					actions: mount.actions,
					input: mount.input,
					handler: bound.handler,
					credential,
					site: bound.site ? (bound.declaration ?? undefined) : undefined,
				})
			}
		}
	}
	const membership = membershipRpc === undefined ? null : new IamMembership(membershipRpc, variables.iamAppId)
	const jobs = bindJobs({
		artifact,
		handlers,
		database,
		framework,
		ownedDimensions: owned,
		reporter: reporterFor('fabrika.jobs') ?? logReporter,
		credentials: workloads,
		mint: issuer.mint,
		data: bound?.data ?? null,
		fileKinds,
		frameworkJobs: fileKinds === null ? [] : [
			...(fileKinds.scans
				? [{
					name: FILE_SCAN_JOB,
					schedule: FILE_SCAN_SCHEDULE,
					timeoutMs: SCAN_LIMITS.jobTimeoutMs,
					run: (reporter: OperationsReporter, signal: AbortSignal) => fileKinds.scanPass(options.scanner ?? null, reporter, signal),
				}]
				: []),
			{
				name: FILE_SWEEP_JOB,
				schedule: FILE_SWEEP_SCHEDULE,
				timeoutMs: FILE_SWEEP_TIMEOUT_MS,
				run: (_reporter, signal) => fileKinds.sweep(signal),
			},
		],
		membership,
		capabilities: issuer.authority,
		containers,
		...(options.revealHandlerErrors === undefined ? {} : { revealHandlerErrors: options.revealHandlerErrors }),
		mail,
		tokens,
		url,
	}, problems)
	for (const id of jobs.declared) {
		declared.add(id)
	}
	for (const [name, declaration] of Object.entries(app.contract.surface.exports ?? {})) {
		const base = exportBase(name, declaration.version)
		for (const { path, procedure } of declaredProcedures(name, declaration.procedures)) {
			const id = [base, ...path.slice(1)].join('.')
			const at = ['exports', ...path]
			declared.add(at.join('.'))
			const row = rows.get(id)
			const bound = boundHandler(at.reduce<unknown>(childAt, handlers), id, `export procedure '${id}'`, 'query', artifact, problems)
			if (!isCredentialed(row)) {
				problems.push(`export procedure '${id}' has no endpoint row`)
			} else if (bound === null) {
				problems.push(`export procedure '${id}' has no handler; add it to handlers.${at.join('.')}`)
			} else {
				endpoints.set(id, {
					kind: 'procedure',
					row,
					input: procedure.input,
					output: procedure.output,
					handler: bound.handler,
					facilities: NO_FACILITIES,
					readOnly: true,
					site: servedSite('query', bound),
					...egressOf(bound),
					...admissionOf(id, artifact, options, problems),
				})
			}
		}
		const row = rows.get(base)
		const description = exportDescription(artifact, name)
		if (isCredentialed(row) && description !== null) {
			endpoints.set(base, { kind: 'description', row, description })
		}
	}
	undeclaredHandlers(handlers, declared, [], problems)
	const data = bound?.data ?? null
	if (data === null && kitOriginOf(app.contract) === 'tableless') {
		servedWithoutData(endpoints, problems)
	}
	const site = [...endpoints.values()].find((served) =>
		served.kind === 'public' || ((served.kind === 'procedure' || served.kind === 'webhook') && served.site !== undefined)
	)
	if (site !== undefined && data === null) {
		problems.push(`'${site.row.id}' reaches data through ctx.db, which runs on @fabrika/db: pass serve(contract, { database: scoped(tables) })`)
	}
	const asking = [...endpoints.values()].find(asksIam)
	if (asking !== undefined && options.membership === undefined) {
		problems.push(
			`'${asking.row.id}' asks IAM to create a scope, manage members or issue a link, and the runtime adapter supplies no IAM membership transport (the IAM binding on Cloudflare; FABRIKA_IAM_RPC_URL and FABRIKA_IAM_RPC_KEY on Bun)`,
		)
	}
	if (problems.length > 0) {
		throw new BootError(problems)
	}

	const runtime = new ContractRuntime({
		table: compileEndpointTable(artifact),
		endpoints,
		digests: new Map(artifact.endpoints.map((row) => [row.id, endpointDigest(artifact, row)])),
		verifier,
		audience: variables.iamAppId,
		proxySecretDigest: proxySecret,
		policy: applicationPolicy(artifact.csp, variables.operationsOrigin),
		database,
		ownedDimensions: owned,
		containers,
		assets: options.assets ?? null,
		membership,
		framework,
		mint: issuer.mint,
		capabilities: issuer.authority,
		data,
		fileKinds,
		failures: new FailureReports(reporterFor('fabrika.requests')),
		kick: jobs.kick,
		actions: Object.freeze(Object.keys(artifact.actions).sort()),
		publicShare: new InFlightShare(publicShareOf(options.connections ?? DEFAULT_CONNECTIONS)),
		clientVouched: options.clientAddress === 'vouched',
		tokens,
		url,
		origin,
	})
	return Object.freeze({
		fetch: (request: Request, exec?: RequestExecutionContext) => runtime.fetch(request, exec),
		jobs: jobs.jobs,
		stopKicks: jobs.stopKicks,
	})
}
