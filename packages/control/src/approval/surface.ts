import { PROCEDURE_LIMITS } from '@fabrika/app/contract'
import {
	type ContractArtifact,
	type EndpointRow,
	type FormMountArtifact,
	isFileShape,
	type ProcedureArtifact,
	type SchemaShape,
} from '@fabrika/auth-core'
import { SURFACE_REACHES, type SurfaceEndpointDto, type SurfaceNoteDto, type SurfaceNoteTopic, type SurfaceReach } from '@fabrika/control-contract'
import { attachmentName, bucketBounds, crossOriginReach, endpointReach, opaqueRoots, requirementPhrase, runPhrase, storedFileName } from './diff'
import { type AccessSnapshot, compareText } from './snapshot'

/**
 * Every endpoint a snapshot publishes, or only those `only` names, grouped by who reaches it, most exposed first, then by
 * path and method.
 */
export function snapshotSurface(snapshot: AccessSnapshot, only?: ReadonlySet<string>): SurfaceEndpointDto[] {
	const contract = snapshot.contract
	if (contract === null) return []
	const roots = new Set(opaqueRoots(contract))
	return contract.endpoints
		.filter((row) => only === undefined || only.has(row.id))
		.map((row) => surfaceEndpoint(contract, roots, row))
		.sort((a, b) => reachRank(a.reach) - reachRank(b.reach) || compareText(a.path, b.path) || compareText(a.method, b.method))
}

function surfaceEndpoint(contract: ContractArtifact, roots: ReadonlySet<string>, row: EndpointRow): SurfaceEndpointDto {
	const notes = notesOf(contract, roots, row)
	return {
		id: row.id,
		method: row.method,
		path: row.path,
		kind: row.kind,
		reach: endpointReach(row),
		callers: [...row.callers],
		requirement: row.requirement === null ? null : requirementPhrase(row.requirement),
		notes: notes.map((note) => note.text),
		noteFacts: notes,
	}
}

function notesOf(contract: ContractArtifact, roots: ReadonlySet<string>, row: EndpointRow): SurfaceNoteDto[] {
	const notes: SurfaceNoteDto[] = []
	const note = (topic: SurfaceNoteTopic, text: string) => notes.push({ topic, text })
	for (const dimension of assertedValues(row)) {
		if (roots.has(dimension)) note('opaque-root', `takes any \`${dimension}\` value under an application-wide grant: an opaque root, unchecked`)
	}
	if (row.crossOrigin !== undefined) note('cross-origin', `callable from ${crossOriginReach(row.crossOrigin)}`)
	const file = attachmentName(row)
	if (file !== null) note('answers-file', `answers ${file}`)
	if (row.output !== null && isFileShape(row.output)) note('answers-file', `answers ${storedFileName(row.output)}`)
	const taken = inputFileKinds(row.input)
	if (taken.length > 0) note('takes-files', `takes files of kind ${taken.map((kind) => `\`${kind}\``).join(', ')}`)
	if (row.kind === 'upload' && row.admission !== null) note('body-limit', uploadLimit(row.admission.maxBytes))
	const mount = row.source.kind === 'mount' ? contract.mounts[row.source.name] : undefined
	if (mount?.kind === 'form') { for (const text of formProtection(mount)) note('form', text) }
	const rules = contract.procedures?.[row.id]
	if (rules !== undefined) notes.push(...procedureProtection(row, rules, taken.length > 0))
	if (mount?.kind === 'webhook') note('signature', `verifies a ${mount.scheme} signature`)
	return notes
}

/** The dimensions whose value the endpoint reads from the request (`in`, or `on` an input field), each once. */
function assertedValues(row: EndpointRow): string[] {
	const requirement = row.requirement
	// `anyOf` reads no scope from the request: its actions are held application-wide.
	if (requirement === null || requirement.kind === 'member' || requirement.kind === 'anyOf') return []
	const forms = requirement.kind === 'action' ? [requirement.access] : Object.values(requirement.capabilities).map((capability) => capability.access)
	const dimensions = forms.flatMap((access) => (access.form === 'in' || (access.form === 'on' && access.from !== null) ? [access.dimension] : []))
	return [...new Set(dimensions)].sort()
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
 * does; a signed-in one names only the buckets it has. Limits that are the framework's defaults (a procedure without
 * file fields, whose default body limit depends on its kinds) are marked, so a page can say them once.
 */
function procedureProtection(row: EndpointRow, rules: ProcedureArtifact, takesFiles: boolean): SurfaceNoteDto[] {
	const guards = [...bucketBounds(rules.rate), ...(rules.challenge === null ? [] : [`${rules.challenge.provider} challenge`])]
	const shown = guards.length === 0 && row.requirement === null ? ['no rate limit and no challenge'] : guards
	const byDefault = !takesFiles && row.admission?.maxBytes === PROCEDURE_LIMITS.maxBytes && rules.timeoutMs === PROCEDURE_LIMITS.timeoutMs
	const limits: SurfaceNoteDto = { topic: 'limits', text: runPhrase(row, rules.timeoutMs) }
	return [...shown.map((text): SurfaceNoteDto => ({ topic: 'guards', text })), byDefault ? { ...limits, default: true } : limits]
}

function reachRank(reach: SurfaceReach): number {
	return SURFACE_REACHES.indexOf(reach)
}
