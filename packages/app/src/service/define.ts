// A service contract: the endpoint table of one of the installation's own services (ADR-0012, ADR-0022 "Installation
// entries"). Plain data over `@fabrika/auth-core` only, so a table module stays dependency-light like a gate module.

import {
	APP_ENVIRONMENT_SEPARATOR,
	type BodyAdmission,
	compileEndpointTable,
	EndpointTableError,
	type InstallationCaller,
	type InstallationEndpointMethod,
	type InstallationEndpointRow,
	type InstallationEndpointTable,
	OAUTH_CALLER,
} from '@fabrika/auth-core'

/** A row as the builder writes it; the record key of `endpoints` becomes its id. */
export type ServiceEndpointSpec = InstallationEndpointRow extends infer Row ? Row extends InstallationEndpointRow ? Omit<Row, 'id'> : never : never

/** One installation service's table, with the row ids as a type so its handlers can be checked against them. */
export interface ServiceArtifact<Id extends string = string> extends InstallationEndpointTable {
	/** The service's IAM app id; never `<app>@<env>`. */
	readonly id: string
	readonly endpoints: readonly (InstallationEndpointRow & { readonly id: Id })[]
}

export interface ServiceEndpointOptions {
	readonly callers: readonly [InstallationCaller, ...InstallationCaller[]]
	/** The request body the row admits; omitted admits none. */
	readonly admission?: BodyAdmission
	/** The scopes an OAuth resource token must carry; required exactly when `callers` holds `oauth`. */
	readonly scopes?: readonly string[]
}

export interface ServiceContractBuilder {
	/** A liveness endpoint: anonymous, and served without `X-Fabrika-Endpoint`. */
	health(method: InstallationEndpointMethod, path: string): ServiceEndpointSpec
	/** An endpoint the service authenticates itself; the proxy reads no credential and keeps `Authorization`. */
	protocol(method: InstallationEndpointMethod, path: string): ServiceEndpointSpec
	/** A credentialed endpoint: a listed caller kind, and no permission (`authenticated`). */
	service(method: InstallationEndpointMethod, path: string, options: ServiceEndpointOptions): ServiceEndpointSpec
}

export interface ServiceContractDeclaration<Id extends string> {
	/** `null` is a row this composition does not serve: the table has no row there, and its handler is never called. */
	readonly endpoints: Readonly<Record<Id, ServiceEndpointSpec | null>>
	/** Literal prefixes a path under which reaches only a row declared under it. */
	readonly reservedPrefixes: readonly string[]
}

export class ServiceContractError extends Error {
	override readonly name = 'ServiceContractError'
	readonly problems: readonly string[]

	constructor(problems: readonly string[]) {
		super(`the service contract is invalid:\n- ${problems.join('\n- ')}`)
		this.problems = problems
	}
}

const builder: ServiceContractBuilder = {
	health: (method, path) => anonymous('health', method, path),
	protocol: (method, path) => anonymous('protocol', method, path),
	service: (method, path, options) => ({
		kind: 'service',
		method,
		path,
		callers: options.callers,
		requirement: { kind: 'authenticated' },
		admission: options.admission ?? null,
		oauth: options.scopes === undefined ? null : { scopes: options.scopes },
	}),
}

function anonymous(kind: 'health' | 'protocol', method: InstallationEndpointMethod, path: string): ServiceEndpointSpec {
	return { kind, method, path, callers: [], requirement: null, admission: null, oauth: null }
}

/**
 * Declare one installation service's endpoint table. Validated here, once: an id that is an application environment,
 * an `oauth` caller without its scopes (or scopes without it), and every table the matcher would refuse.
 */
export function defineServiceContract<const Id extends string>(
	id: string,
	declare: (s: ServiceContractBuilder) => ServiceContractDeclaration<Id>,
): ServiceArtifact<Id> {
	const declaration = declare(builder)
	const endpoints = servedEntries(declaration.endpoints).map(([rowId, spec]) => ({ ...spec, id: rowId }))
	const problems: string[] = []
	if (id === '' || id.includes(APP_ENVIRONMENT_SEPARATOR)) {
		problems.push(`'${id}' is no installation service id: it must be non-empty and hold no '${APP_ENVIRONMENT_SEPARATOR}'`)
	}
	for (const row of endpoints) {
		const admitsOAuth = row.callers.some((caller) => caller === OAUTH_CALLER)
		if (admitsOAuth !== (row.oauth !== null)) {
			problems.push(`'${row.id}' must declare scopes exactly when it admits the caller '${OAUTH_CALLER}'`)
		}
		if (row.oauth !== null && row.oauth.scopes.length === 0) {
			problems.push(`'${row.id}' admits '${OAUTH_CALLER}' with no scope`)
		}
	}
	const table = { endpoints, reservedPrefixes: [...declaration.reservedPrefixes] }
	try {
		compileEndpointTable(table)
	} catch (error) {
		if (!(error instanceof EndpointTableError)) throw error
		problems.push(...error.problems)
	}
	if (problems.length > 0) {
		throw new ServiceContractError(problems)
	}
	return { id, ...table }
}

function servedEntries<Id extends string, Value>(record: Readonly<Record<Id, Value | null>>): [Id, Value][] {
	const entries: [Id, Value][] = []
	for (const key in record) {
		const value = record[key]
		if (Object.hasOwn(record, key) && value !== null) entries.push([key, value])
	}
	return entries
}
