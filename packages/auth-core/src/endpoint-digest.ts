// The digests that bind the proxy and the application to the same rules (ADR-0022 rule 5): one per endpoint, sent
// with every allowed request, and one for the whole contract, checked once at startup.

import type { ContractArtifact, EndpointRow, ExportDescription } from './contract'
import { canonicalAdmission, canonicalArtifactJson, canonicalJson, canonicalShape } from './contract-canonical'
import type { InstallationEndpointRow, InstallationEndpointTable } from './installation-endpoint'
import { sha256Hex } from './sha256'

/** The variable that carries the digest of the contract a deploy was approved with; the application compares its own. */
export const FABRIKA_CONTRACT_DIGEST = 'FABRIKA_CONTRACT_DIGEST'

/**
 * The variable that carries `installationTableDigest` of the table an installation service's proxy publishes; the
 * service picks its own table by it and refuses to start when it names none.
 */
export const FABRIKA_SERVICE_TABLE_DIGEST = 'FABRIKA_SERVICE_TABLE_DIGEST'

/**
 * What a membership or scope-creating endpoint spends at IAM through a single-use delegation grant (ADR-0022 rule 6):
 * `creates` for an endpoint that creates a value, `members` for one whose action is the `members.manage` action of the
 * dimension its access form names.
 */
export type EndpointDelegation = 'members' | 'creates'

/**
 * The fields of an endpoint row the proxy applies, with its delegation. Its digest covers exactly these. An
 * installation row adds its OAuth scopes; an application row has no `oauth` field.
 */
export type EndpointRules =
	| (Pick<EndpointRow, 'kind' | 'method' | 'path' | 'callers' | 'requirement' | 'admission'> & {
		readonly delegation: EndpointDelegation | null
	})
	| (Pick<InstallationEndpointRow, 'kind' | 'method' | 'path' | 'callers' | 'requirement' | 'admission' | 'oauth'> & {
		readonly delegation: null
	})

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

/** Whether `value` has the form every digest here has, `sha256:<64 hex digits>`. */
export function isDigest(value: string): boolean {
	return DIGEST_PATTERN.test(value)
}

/** The one derivation of an endpoint's delegation: the proxy table, the IAM schema and the digest all read it. */
export function endpointDelegation(artifact: Pick<ContractArtifact, 'dimensions'>, row: EndpointRow): EndpointDelegation | null {
	if (row.requirement?.kind !== 'action') {
		return null
	}
	const { action, access } = row.requirement
	if (access.form === 'creates') {
		return 'creates'
	}
	if (access.form === 'app') {
		return null
	}
	const managed = Object.hasOwn(artifact.dimensions, access.dimension) ? artifact.dimensions[access.dimension]?.members : null
	return managed?.manage === action ? 'members' : null
}

/** The digest of an artifact's endpoint row, its delegation derived from the artifact. */
export function endpointDigest(artifact: Pick<ContractArtifact, 'dimensions'>, row: EndpointRow): string {
	return requirementDigest({ ...row, delegation: endpointDelegation(artifact, row) })
}

/**
 * The digest of what the proxy applies to an endpoint: its kind, method, path, callers, requirement, admission and
 * delegation, and an installation row's OAuth scopes.
 * Caller, content-type and scope order carry no meaning, so they do not change it; input and output schemas are not
 * part of it, because the proxy does not apply them.
 */
export function requirementDigest(rules: EndpointRules): string {
	const callers = sortedCodeUnits(rules.callers)
	const applied = {
		kind: rules.kind,
		method: rules.method,
		path: rules.path,
		callers,
		requirement: rules.requirement,
		admission: rules.admission === null ? null : canonicalAdmission(rules.admission),
		delegation: rules.delegation,
	}
	// Only a row that admits `oauth` adds the key, so every application row keeps its digest byte for byte.
	const oauth = 'oauth' in rules ? rules.oauth : null
	return digestOf(canonicalJson(oauth === null ? applied : { ...applied, oauth: { scopes: sortedCodeUnits(oauth.scopes) } }))
}

function sortedCodeUnits(values: readonly string[]): string[] {
	return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** The digest of the whole artifact, over its one canonical serialization. */
export function contractDigest(artifact: ContractArtifact): string {
	return digestOf(canonicalArtifactJson(artifact))
}

/**
 * The digest of an installation service's table: each row's id and `requirementDigest`, and the reserved prefixes. A
 * composition writes it beside the service from the table its proxy publishes, so the service refuses to start under
 * another table (ADR-0022 "Installation entries"). Row and prefix order carry no meaning.
 */
export function installationTableDigest(table: InstallationEndpointTable): string {
	const endpoints = table.endpoints.map((row) => `${row.id}@${requirementDigest({ ...row, delegation: null })}`)
	return digestOf(canonicalJson({ endpoints: sortedCodeUnits(endpoints), reservedPrefixes: sortedCodeUnits(table.reservedPrefixes) }))
}

/**
 * The digest of an export's description: what a consumer's vendored snapshot and its import name, so a schema that
 * changed under the same version is told apart.
 */
export function exportDigest(description: Omit<ExportDescription, 'digest'>): string {
	const procedures = Object.fromEntries(
		Object.entries(description.procedures).map(([path, procedure]) => [path, {
			input: procedure.input === null ? null : canonicalShape(procedure.input),
			output: canonicalShape(procedure.output),
		}]),
	)
	return digestOf(canonicalJson({
		app: description.app,
		export: description.export,
		version: description.version,
		audience: description.audience,
		procedures,
	}))
}

/** `X-Fabrika-Endpoint`'s value: the endpoint id the proxy selected and the digest of the rules it applied. */
export function formatEndpointHeader(id: string, digest: string): string {
	return `${id}@${digest}`
}

/** Read `X-Fabrika-Endpoint`; `null` for anything that is not `<id>@sha256:<hex>`. */
export function parseEndpointHeader(value: string): { readonly id: string; readonly digest: string } | null {
	const separator = value.lastIndexOf('@')
	const id = value.slice(0, separator)
	const digest = value.slice(separator + 1)
	return separator <= 0 || !isDigest(digest) ? null : { id, digest }
}

function digestOf(json: string): string {
	return `sha256:${sha256Hex(json)}`
}
