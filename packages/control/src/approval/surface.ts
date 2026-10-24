import { APP_CALLER_PREFIX, type ContractArtifact, type EndpointRow, type FormMountArtifact, isFileShape, type SchemaShape } from '@fabrika/auth-core'
import { SURFACE_REACHES, type SurfaceEndpointDto, type SurfaceReach } from '@fabrika/control-contract'
import { attachmentName, crossOriginReach, opaqueRoots, requirementPhrase, storedFileName } from './diff'
import { type AccessSnapshot, compareText } from './snapshot'

/** Every endpoint a snapshot publishes, grouped by who reaches it, most exposed first, then by path and method. */
export function snapshotSurface(snapshot: AccessSnapshot): SurfaceEndpointDto[] {
	const contract = snapshot.contract
	if (contract === null) return []
	return contract.endpoints
		.map((row) => surfaceEndpoint(contract, new Set(opaqueRoots(contract)), row))
		.sort((a, b) => reachRank(a.reach) - reachRank(b.reach) || compareText(a.path, b.path) || compareText(a.method, b.method))
}

function surfaceEndpoint(contract: ContractArtifact, roots: ReadonlySet<string>, row: EndpointRow): SurfaceEndpointDto {
	return {
		id: row.id,
		method: row.method,
		path: row.path,
		kind: row.kind,
		reach: reachOf(row),
		callers: [...row.callers],
		requirement: row.requirement === null ? null : requirementPhrase(row.requirement),
		notes: notesOf(contract, roots, row),
	}
}

function reachOf(row: EndpointRow): SurfaceReach {
	if (row.requirement === null) return 'anyone'
	if (row.callers.includes('link')) return 'link'
	if (row.callers.some((caller) => caller.startsWith(APP_CALLER_PREFIX))) return 'app'
	return row.callers.includes('machine') ? 'machine' : 'human'
}

function notesOf(contract: ContractArtifact, roots: ReadonlySet<string>, row: EndpointRow): string[] {
	const notes: string[] = []
	for (const dimension of assertedValues(row)) {
		if (roots.has(dimension)) notes.push(`takes any \`${dimension}\` value under an application-wide grant: an opaque root, unchecked`)
	}
	if (row.crossOrigin !== undefined) notes.push(`callable from ${crossOriginReach(row.crossOrigin)}`)
	const file = attachmentName(row)
	if (file !== null) notes.push(`answers ${file}`)
	if (row.output !== null && isFileShape(row.output)) notes.push(`answers ${storedFileName(row.output)}`)
	const taken = inputFileKinds(row.input)
	if (taken.length > 0) notes.push(`takes files of kind ${taken.map((kind) => `\`${kind}\``).join(', ')}`)
	if (row.kind === 'upload' && row.admission !== null) notes.push(uploadLimit(row.admission.maxBytes))
	const mount = row.source.kind === 'mount' ? contract.mounts[row.source.name] : undefined
	if (mount?.kind === 'form') notes.push(...formProtection(mount))
	if (mount?.kind === 'webhook') notes.push(`verifies a ${mount.scheme} signature`)
	return notes
}

/** The dimensions whose value the endpoint reads from the request (`in`, or `on` an input field), each once. */
function assertedValues(row: EndpointRow): string[] {
	const requirement = row.requirement
	if (requirement === null || requirement.kind === 'member') return []
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

function reachRank(reach: SurfaceReach): number {
	return SURFACE_REACHES.indexOf(reach)
}
