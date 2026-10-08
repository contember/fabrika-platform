// `boot(app, { environment, iam })`: called once, by the generated entrypoint through its runtime adapter, after the
// adapter captured the framework's variables and scrubbed them from the process. It compiles the contract, binds
// every handler to its endpoint and refuses to start when anything declared cannot be served.

import {
	compileEndpointTable,
	type ContractArtifact,
	contractDigest,
	type CredentialedEndpoint,
	endpointDigest,
	type EndpointRow,
	FABRIKA_CONTRACT_DIGEST,
	FABRIKA_IAM_APP_ID,
	FABRIKA_PROXY_SECRET,
	type Jwks,
	parseAppEnvironmentId,
} from '@fabrika/auth-core'
import type { Database } from '@fabrika/db'
import { bindScopedDatabase, isScopedDatabase } from '@fabrika/db/framework'
import { TokenVerifier } from '@fabrika/jwks'
import type { FileObjectStore } from '@fabrika/platform'
import { compileContract } from '../contract/compile'
import { isProcedure, type ProcedureDeclaration, type ProcedureTreeDeclaration, SURFACE_SECTIONS } from '../contract/declaration'
import type { Schema } from '../contract/define'
import { fileCollections } from '../files/collections'
import { requestCapabilities } from './capability'
import { ContractRuntime, proxySecretDigest, type ServedEndpoint, type SpaAssets } from './dispatch'
import type { CapturedEnvironment } from './environment'
import { headerPolicy } from './headers'
import type { ContractDatabase, ContractImplementation, ImplementationDatabase } from './implement'

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
	/** The object storage of the file collections, which the Bun adapter opens. Without it, a contract with files does not boot. */
	readonly files?: FileObjectStore
}

export interface ContractApp {
	fetch(request: Request): Promise<Response>
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
		if (mount.kind === 'link' || mount.kind === 'form' || mount.kind === 'webhook') {
			problems.push(`mount '${name}' is a ${mount.kind} mount, which this version of @fabrika/app does not serve yet`)
		}
		if (mount.kind === 'spa' && assets === undefined) {
			problems.push(`mount '${name}' is an SPA, and the runtime adapter supplies no asset server`)
		}
	}
	for (
		const [section, entries] of Object.entries({
			jobs: artifact.jobs,
			exports: artifact.exports,
			imports: artifact.imports,
		})
	) {
		for (const name of Object.keys(entries)) {
			problems.push(`${section} '${name}' is declared, and this version of @fabrika/app does not run ${section} yet`)
		}
	}
	for (const row of artifact.endpoints) {
		if (row.requirement?.kind !== 'action') {
			continue
		}
		const { access } = row.requirement
		if (access.form === 'creates') {
			problems.push(`'${row.id}' creates a '${access.dimension}', and this version cannot ask IAM for a new scope yet`)
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

/** Every function in the tree must be a declared procedure's handler, even when a cast defeated `implement`'s types. */
function undeclaredHandlers(node: unknown, declared: ReadonlySet<string>, path: readonly string[], problems: string[]): void {
	const id = path.join('.')
	if (typeof node === 'function') {
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

/**
 * The database `dispatch` reads. A `scoped(tables)` result is bound here, once, to the adapter's connection and the
 * authority that binds capabilities to requests; the application never receives either, nor the locator.
 */
function contractDatabase(database: ImplementationDatabase | null, connection: Database | undefined, problems: string[]): ContractDatabase | null {
	if (database === null) {
		return null
	}
	if (!isScopedDatabase(database)) {
		if ('locate' in database) {
			return database
		}
		problems.push('implement({ database }) takes the scoped(tables) result of @fabrika/db itself, not a copy or a wrapper of it')
		return null
	}
	if (connection === undefined) {
		problems.push('the application uses @fabrika/db, which runs on Bun with Postgres, and the runtime adapter supplies no database connection')
		return null
	}
	try {
		return { tables: database.tables, locate: bindScopedDatabase(database, { database: connection, capabilities: requestCapabilities }) }
	} catch {
		problems.push('the data layer was bound before boot; only the framework binds it, so remove @fabrika/db/framework from the application')
		return null
	}
}

function isCredentialed(row: EndpointRow | undefined): row is CredentialedEndpoint {
	return row !== undefined && row.requirement !== null
}

export function boot(app: ContractImplementation, options: BootOptions): ContractApp {
	const problems: string[] = []
	const framework = readFramework(options.environment.framework, app.contract.vocabulary.app, problems)
	const artifact = compileContract(app.contract, app.database?.tables ?? {})
	checkContractDigest(options.environment.framework, artifact, problems)
	const proxySecret = readProxySecret(options.environment.framework, options.requireProxySecret === true, problems)
	const owned = new Set(Object.values(artifact.tables).flatMap((table) => table.scope.mode === 'dimension' ? [table.scope.dimension] : []))
	// A file collection's dimension is located through its own table and its owner's.
	for (const name of Object.keys(artifact.files)) {
		owned.add(`file:${name}`)
	}
	const containers = containersOf(artifact)
	unservable(artifact, options.assets, owned, containers, problems)
	const files = fileCollections(artifact, app.database, options.files, problems)
	const bound = contractDatabase(app.database, options.database, problems)
	const database = files === null || bound === null ? bound : files.locating(bound)
	if (problems.length > 0) {
		throw new BootError(problems)
	}

	const rows = new Map(artifact.endpoints.map((row) => [row.id, row]))
	const endpoints = new Map<string, ServedEndpoint>()
	const handlers = app.handlers(options.environment.application, { capabilities: requestCapabilities })
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
			if (isCredentialed(row)) {
				endpoints.set(name, { kind: 'spa', row, prefix: mount.prefix, dir: mount.dir })
			}
		} else if (mount.kind === 'rpc') {
			for (const { id, path, procedure } of declaredProcedures(name, mount.procedures)) {
				declared.add(id)
				const row = rows.get(id)
				const handler = path.reduce<unknown>(childAt, handlers)
				if (!isCredentialed(row)) {
					problems.push(`procedure '${id}' has no endpoint row`)
				} else if (typeof handler !== 'function') {
					problems.push(`procedure '${id}' has no handler; add it to handlers`)
				} else {
					endpoints.set(id, {
						kind: 'procedure',
						row,
						input: procedure.input,
						output: procedure.output,
						handler: (args) => Reflect.apply(handler, undefined, [args]),
					})
				}
			}
		}
	}
	for (const [id, served] of files?.endpoints(rows, problems) ?? []) {
		endpoints.set(id, served)
	}
	undeclaredHandlers(handlers, declared, [], problems)
	if (problems.length > 0) {
		throw new BootError(problems)
	}

	return new ContractRuntime({
		table: compileEndpointTable(artifact),
		endpoints,
		digests: new Map(artifact.endpoints.map((row) => [row.id, endpointDigest(artifact, row)])),
		verifier: new TokenVerifier({ getJwks: () => options.iam.getJwks(), issuer: framework.issuer }),
		audience: framework.iamAppId,
		proxySecretDigest: proxySecret,
		policy: headerPolicy(artifact.csp, framework.operationsOrigin),
		database,
		ownedDimensions: owned,
		containers,
		assets: options.assets ?? null,
	})
}
