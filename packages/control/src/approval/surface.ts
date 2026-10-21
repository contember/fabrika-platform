import {
	type ContractArtifact,
	type EndpointRow,
	type FormMountArtifact,
	isFileShape,
	type ProcedureArtifact,
	type SchemaShape,
} from '@fabrika/auth-core'
import { SURFACE_REACHES, type SurfaceEndpointDto, type SurfaceReach } from '@fabrika/control-contract'
import { attachmentName, bucketBounds, crossOriginReach, endpointReach, requirementPhrase, runPhrase, storedFileName } from './diff'
import { type AccessSnapshot, compareText } from './snapshot'

/**
 * Every endpoint a snapshot publishes, or only those `only` names, grouped by who reaches it, most exposed first, then by
 * path and method.
 */
export function snapshotSurface(snapshot: AccessSnapshot, only?: ReadonlySet<string>): SurfaceEndpointDto[] {
	const contract = snapshot.contract
	if (contract === null) return []
	return contract.endpoints
		.filter((row) => only === undefined || only.has(row.id))
		.map((row) => surfaceEndpoint(contract, row))
		.sort((a, b) => reachRank(a.reach) - reachRank(b.reach) || compareText(a.path, b.path) || compareText(a.method, b.method))
}

function surfaceEndpoint(contract: ContractArtifact, row: EndpointRow): SurfaceEndpointDto {
	return {
		id: row.id,
		method: row.method,
		path: row.path,
		kind: row.kind,
		reach: endpointReach(row),
		callers: [...row.callers],
		requirement: row.requirement === null ? null : requirementPhrase(row.requirement),
		notes: notesOf(contract, row),
	}
}

function notesOf(contract: ContractArtifact, row: EndpointRow): string[] {
	const notes: string[] = []
	if (row.crossOrigin !== undefined) notes.push(`callable from ${crossOriginReach(row.crossOrigin)}`)
	const file = attachmentName(row)
	if (file !== null) notes.push(`answers ${file}`)
	if (row.output !== null && isFileShape(row.output)) notes.push(`answers ${storedFileName(row.output)}`)
	const taken = inputFileKinds(row.input)
	if (taken.length > 0) notes.push(`takes files of kind ${taken.map((kind) => `\`${kind}\``).join(', ')}`)
	if (row.kind === 'upload' && row.admission !== null) notes.push(uploadLimit(row.admission.maxBytes))
	const mount = row.source.kind === 'mount' ? contract.mounts[row.source.name] : undefined
	if (mount?.kind === 'form') notes.push(...formProtection(mount))
	const rules = contract.procedures?.[row.id]
	if (rules !== undefined) notes.push(...procedureProtection(row, rules))
	if (mount?.kind === 'webhook') notes.push(`verifies a ${mount.scheme} signature`)
	return notes
}

/** The kinds of an input's file fields: a file, an optional one, or an array of them. */
function inputFileKinds(input: SchemaShape | null): string[] {
	const kindOf = (shape: SchemaShape): string | undefined =>
		shape.type === 'file' ? shape.kind : shape.type === 'optional' ? kindOf(shape.inner) : shape.type === 'array' ? kindOf(shape.items) : undefined
	const kinds = input?.type === 'object' ? Object.values(input.fields).map(kindOf) : []
	return [...new Set(kinds.filter((kind) => kind !== undefined))].sort()
}

function uploadLimit(maxBytes: number | null): string {
	return maxBytes === null ? 'accepts a body of any size' : `accepts a body of at most ${maxBytes} bytes`
}

/** A form takes anonymous submissions, so its rate limits and challenge are what stand in front of its inbox. */
function formProtection(form: FormMountArtifact): string[] {
	const notes: string[] = []
	if (form.rate?.perClient !== undefined) notes.push(`at most ${form.rate.perClient} submissions a minute per client`)
	if (form.rate?.perForm !== undefined) notes.push(`at most ${form.rate.perForm} submissions a minute in all`)
	if (form.challenge !== undefined) notes.push(`${form.challenge.provider} challenge`)
	if (form.honeypot !== undefined) notes.push(`honeypot field \`${form.honeypot}\``)
	return notes.length === 0 ? ['no rate limit and no challenge'] : notes
}

/**
 * A procedure's buckets and challenge, which stand in front of its handler, then how long it waits for a body of what
 * size and how long it runs, in the approval's words. A public one without a bucket or a challenge says so, as a form
 * does; a signed-in one names only the buckets it has.
 */
function procedureProtection(row: EndpointRow, rules: ProcedureArtifact): string[] {
	const guards = [...bucketBounds(rules.rate), ...(rules.challenge === null ? [] : [`${rules.challenge.provider} challenge`])]
	return [...(guards.length === 0 && row.requirement === null ? ['no rate limit and no challenge'] : guards), runPhrase(row, rules.timeoutMs)]
}

function reachRank(reach: SurfaceReach): number {
	return SURFACE_REACHES.indexOf(reach)
}
