// `src/__tests__/endpoint-access.fixtures.ts`: what an application's author gives the endpoint access tests. `fixtures`
// are the inputs the scaffold cannot sample (a `regex`); `seeds` are the state of the row an endpoint addresses, which
// its precondition needs (`deals.reopen` reopens only a won deal: `{ stage: 'won' }`); `members` are the input fields
// that name a member the handler looks up (`deals.assign`'s `ownerId`), which the kit fills with a real member;
// `invitations` and `links` the fields that name an invitation the handler cancels or a share link it revokes, which the
// kit fills with one it holds. Read from source, never executed, within the reader's budget:
// `export const fixtures = { '<endpoint id>': { … } }`, `export const seeds = { '<endpoint id>': { <column>: <value> } }`
// and `export const members = { '<endpoint id>': ['<field>'] }` (`invitations`, `links` alike), plain literals only.
// Browser-safe.

import { type AstNode, child, children, identifierName, nodeDepth, parseModule, positionOf, staticKey, staticString } from './ast'
import type { Finding } from './finding'
import { ENDPOINT_FIXTURES_FILE } from './layout'
import { CONTRACT_LIMITS } from './limits'
import type { Sample } from './scaffold-sample'

export const FIXTURES_EXPORT = 'fixtures'
export const SEEDS_EXPORT = 'seeds'
export const MEMBERS_EXPORT = 'members'
export const INVITATIONS_EXPORT = 'invitations'
export const LINKS_EXPORT = 'links'

/** The exports that list, by endpoint id, the input fields the kit fills with something it holds. */
const FIELD_EXPORTS = [MEMBERS_EXPORT, INVITATIONS_EXPORT, LINKS_EXPORT] as const
type FieldExport = (typeof FIELD_EXPORTS)[number]
const isFieldExport = (name: string | undefined): name is FieldExport => FIELD_EXPORTS.some((field) => field === name)

const ALLOWED =
	"export const fixtures = { 'api.notes.get': { id: '…' } }, export const seeds = { 'api.deals.reopen': { stage: 'won' } }, export const members = { 'api.deals.assign': ['ownerId'] }, export const invitations = { 'api.members.cancel': ['invitationId'] } and export const links = { 'api.notes.unshare': ['linkId'] }: string keys, and strings, numbers, booleans, null, arrays and objects"

type ById = Readonly<Record<string, Readonly<Record<string, Sample>>>>

export interface EndpointFixtures {
	/** The input each endpoint's cases send, by endpoint id. */
	readonly inputs: ById
	/** The columns of the row each endpoint addresses, as both scopes' rows are seeded, by endpoint id. */
	readonly seeds: ById
	/** The input fields that name a member of the endpoint's member directory, by endpoint id. */
	readonly members: Readonly<Record<string, readonly string[]>>
	/** The input fields that name an invitation the endpoint cancels, by endpoint id. */
	readonly invitations: Readonly<Record<string, readonly string[]>>
	/** The input fields that name a share link the endpoint revokes, by endpoint id. */
	readonly links: Readonly<Record<string, readonly string[]>>
}

export const NO_FIXTURES: EndpointFixtures = { inputs: {}, seeds: {}, members: {}, invitations: {}, links: {} }

const finding = (at: AstNode | undefined, message: string): Finding => {
	const { line, column } = at === undefined ? { line: 1, column: 1 } : positionOf(at)
	return { file: ENDPOINT_FIXTURES_FILE, line, column, severity: 'refusal', rule: 'endpoint-fixture', message, allowed: ALLOWED }
}

export function isSampleObject(value: Sample): value is { readonly [key: string]: Sample } {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A plain literal value, or the node that is not one. */
function literal(
	node: AstNode | undefined,
): { readonly ok: true; readonly value: Sample } | { readonly ok: false; readonly at: AstNode | undefined } {
	if (node === undefined) return { ok: false, at: node }
	if (node.type === 'Literal') {
		const value = node['value']
		if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
			return { ok: true, value }
		}
		return { ok: false, at: node }
	}
	if (node.type === 'TemplateLiteral') {
		const text = staticString(node)
		return text === undefined ? { ok: false, at: node } : { ok: true, value: text }
	}
	if (node.type === 'UnaryExpression' && node['operator'] === '-') {
		const inner = literal(child(node, 'argument'))
		return inner.ok && typeof inner.value === 'number' ? { ok: true, value: -inner.value } : { ok: false, at: node }
	}
	if (node.type === 'ArrayExpression') {
		const items: Sample[] = []
		for (const element of children(node, 'elements')) {
			const item = literal(element ?? undefined)
			if (!item.ok) return item
			items.push(item.value)
		}
		return { ok: true, value: items }
	}
	if (node.type === 'ObjectExpression') {
		const entries: [string, Sample][] = []
		for (const property of children(node, 'properties')) {
			if (property?.type !== 'Property' || property['computed'] === true || property['method'] === true) return { ok: false, at: property ?? node }
			const key = staticKey(property, 'key')
			if (key === undefined || key === '__proto__') return { ok: false, at: property }
			const value = literal(child(property, 'value'))
			if (!value.ok) return value
			entries.push([key, value.value])
		}
		return { ok: true, value: Object.fromEntries(entries) }
	}
	return { ok: false, at: node }
}

/** One `export const <name> = { '<endpoint id>': { … } }`, read into an object of objects. */
function byId(
	declarator: AstNode,
	name: string,
): { readonly ok: true; readonly value: ById } | { readonly ok: false; readonly findings: readonly Finding[] } {
	const init = child(declarator, 'init')
	const value = literal(init)
	if (!value.ok) return { ok: false, findings: [finding(value.at, 'not a plain literal')] }
	const all = value.value
	if (!isSampleObject(all)) {
		return { ok: false, findings: [finding(init, `the ${name} are an object keyed by endpoint id`)] }
	}
	const entries: Record<string, Readonly<Record<string, Sample>>> = {}
	for (const [id, entry] of Object.entries(all)) {
		if (!isSampleObject(entry)) {
			return { ok: false, findings: [finding(init, `the ${name} of ${id} is not an object of ${name === SEEDS_EXPORT ? 'columns' : 'input fields'}`)] }
		}
		entries[id] = entry
	}
	return { ok: true, value: entries }
}

/** `export const <members, invitations or links> = { '<endpoint id>': ['<field>', …] }`, read into field lists. */
function fieldsById(
	declarator: AstNode,
	name: FieldExport,
): { readonly ok: true; readonly value: Readonly<Record<string, readonly string[]>> } | {
	readonly ok: false
	readonly findings: readonly Finding[]
} {
	const init = child(declarator, 'init')
	const value = literal(init)
	if (!value.ok) return { ok: false, findings: [finding(value.at, 'not a plain literal')] }
	if (!isSampleObject(value.value)) {
		return { ok: false, findings: [finding(init, `the ${name} are an object keyed by endpoint id`)] }
	}
	const entries: Record<string, readonly string[]> = {}
	for (const [id, fields] of Object.entries(value.value)) {
		if (!Array.isArray(fields) || fields.length === 0 || !fields.every((field) => typeof field === 'string')) {
			return { ok: false, findings: [finding(init, `the ${name} of ${id} is not a list of input field names`)] }
		}
		entries[id] = fields.filter((field) => typeof field === 'string')
	}
	return { ok: true, value: entries }
}

/** The fixtures of `files`, by endpoint id; none without the file. */
export function readEndpointFixtures(
	files: ReadonlyMap<string, string>,
): { readonly ok: true; readonly fixtures: EndpointFixtures } | { readonly ok: false; readonly findings: readonly Finding[] } {
	const text = files.get(ENDPOINT_FIXTURES_FILE)
	if (text === undefined) return { ok: true, fixtures: NO_FIXTURES }
	if (new TextEncoder().encode(text).byteLength > CONTRACT_LIMITS.sourceBytes) {
		return { ok: false, findings: [finding(undefined, `the fixtures exceed ${CONTRACT_LIMITS.sourceBytes} bytes`)] }
	}
	const parsed = parseModule(ENDPOINT_FIXTURES_FILE, text)
	if (!parsed.ok) return { ok: false, findings: [finding(undefined, parsed.message)] }
	const program = parsed.module.program
	if (nodeDepth(program) > CONTRACT_LIMITS.astDepth) {
		return { ok: false, findings: [finding(undefined, `the fixtures nest deeper than ${CONTRACT_LIMITS.astDepth}`)] }
	}
	const read = new Map<string, ById>()
	const fields = new Map<FieldExport, Readonly<Record<string, readonly string[]>>>()
	for (const statement of children(program, 'body')) {
		const declaration = statement === null ? undefined : child(statement, 'declaration')
		const declarators = declaration?.type === 'VariableDeclaration' && declaration['kind'] === 'const' ? children(declaration, 'declarations') : []
		const declarator = declarators.length === 1 ? declarators[0] : undefined
		const name = declarator === null || declarator === undefined ? undefined : identifierName(child(declarator, 'id'))
		if (
			statement?.type !== 'ExportNamedDeclaration' || declarator === null || declarator === undefined
			|| (name !== FIXTURES_EXPORT && name !== SEEDS_EXPORT && !isFieldExport(name)) || read.has(name)
			|| (isFieldExport(name) && fields.has(name))
		) {
			return {
				ok: false,
				findings: [
					finding(
						statement ?? undefined,
						`the file holds export const ${FIXTURES_EXPORT}, ${SEEDS_EXPORT}, ${MEMBERS_EXPORT}, ${INVITATIONS_EXPORT} and ${LINKS_EXPORT} = { … }, each at most once`,
					),
				],
			}
		}
		if (isFieldExport(name)) {
			const listed = fieldsById(declarator, name)
			if (!listed.ok) return listed
			fields.set(name, listed.value)
			continue
		}
		const value = byId(declarator, name)
		if (!value.ok) return value
		read.set(name, value.value)
	}
	return {
		ok: true,
		fixtures: {
			inputs: read.get(FIXTURES_EXPORT) ?? {},
			seeds: read.get(SEEDS_EXPORT) ?? {},
			members: fields.get(MEMBERS_EXPORT) ?? {},
			invitations: fields.get(INVITATIONS_EXPORT) ?? {},
			links: fields.get(LINKS_EXPORT) ?? {},
		},
	}
}
