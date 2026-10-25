// `src/__tests__/endpoint-access.fixtures.ts`: what an application's author gives the endpoint access tests. `fixtures`
// are the inputs the scaffold cannot sample (a `regex`); `seeds` are the state of the row an endpoint addresses, which
// its precondition needs (`deals.reopen` reopens only a won deal: `{ stage: 'won' }`); `members` are the input fields
// that name a member the handler looks up (`deals.assign`'s `ownerId`), which the kit fills with a real member;
// `invitations` and `links` the fields that name an invitation the handler cancels or a share link it revokes, which the
// kit fills with one it holds; `rows` the fields that name a row lying in the endpoint's object (a note's comment), by
// table, which the kit seeds in each scope's object; `appRows` the rows of application tables an endpoint's own case
// reads (the guide a link holder downloads), by table, with their columns, which the kit seeds before each leak or own
// case asks and removes once it is over; `files` the file of the repository each generated case sends in a file field
// (a package a handler inspects), by input field, relative to the application's root; `refusals` the error types of the
// 400s an endpoint's handler answers its own object with when no fixture can meet its domain rule, which the kit then
// counts as the handler's answer.
// Read from source, never executed, within the reader's budget: `export const fixtures = { '<endpoint id>': { … } }`,
// `export const seeds = { '<endpoint id>': { <column>: <value> } }`, `export const members = { '<endpoint id>':
// ['<field>'] }` (`invitations`, `links` alike), `export const rows = { '<endpoint id>': { <field>: '<table>' } }` and
// `export const appRows = { '<endpoint id>': { <table>: { <column>: <value> } } }`, `export const files = { '<endpoint
// id>': { <field>: '<path>' } }` and `export const refusals = { '<endpoint id>': ['<error type>'] }`, plain literals only.
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
export const ROWS_EXPORT = 'rows'
export const APP_ROWS_EXPORT = 'appRows'
export const FILES_EXPORT = 'files'
export const REFUSALS_EXPORT = 'refusals'

/** The exports that list strings by endpoint id: the input fields the kit fills with something it holds, and the refusals. */
const FIELD_EXPORTS = [MEMBERS_EXPORT, INVITATIONS_EXPORT, LINKS_EXPORT, REFUSALS_EXPORT] as const
type FieldExport = (typeof FIELD_EXPORTS)[number]
const isFieldExport = (name: string | undefined): name is FieldExport => FIELD_EXPORTS.some((field) => field === name)

const ALLOWED =
	"export const fixtures = { 'api.notes.get': { id: '…' } }, export const seeds = { 'api.deals.reopen': { stage: 'won' } }, export const members = { 'api.deals.assign': ['ownerId'] }, export const invitations = { 'api.members.cancel': ['invitationId'] }, export const links = { 'api.notes.unshare': ['linkId'] }, export const rows = { 'api.notes.editComment': { commentId: 'note_comments' } }, export const appRows = { 'portal.guide': { guides: { active: true } } }, export const files = { 'api.skills.publish': { package: 'src/__tests__/fixtures/skill.zip' } } and export const refusals = { 'api.skills.publish': ['skill_frontmatter'] }: string keys, and strings, numbers, booleans, null, arrays and objects"

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
	/** The input fields that name a row lying in the endpoint's object, with that row's table, by endpoint id. */
	readonly rows: Readonly<Record<string, Readonly<Record<string, string>>>>
	/** The rows of application tables the endpoint's own case reads, by table, each with its columns, by endpoint id. */
	readonly appRows: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, Sample>>>>>>
	/** The file each case sends in a file field, a path relative to the application's root, by input field, by endpoint id. */
	readonly files: Readonly<Record<string, Readonly<Record<string, string>>>>
	/** The error types of the 400s an endpoint's handler may answer its own object with, by endpoint id. */
	readonly refusals: Readonly<Record<string, readonly string[]>>
}

export const NO_FIXTURES: EndpointFixtures = {
	inputs: {},
	seeds: {},
	members: {},
	invitations: {},
	links: {},
	rows: {},
	appRows: {},
	files: {},
	refusals: {},
}

/**
 * Whether `path` may name a file fixture: relative to the application's root, `/`-separated, and each segment of
 * letters, digits, `_`, `-` and `.` that starts with neither `.` nor `-`, so it never leaves the root, names no dotfile and
 * reads the same as a URL path.
 */
export const isFixtureFilePath = (path: string): boolean => /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/.test(path)

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
			const of = name === SEEDS_EXPORT ? 'columns' : name === APP_ROWS_EXPORT ? 'tables' : 'input fields'
			return { ok: false, findings: [finding(init, `the ${name} of ${id} is not an object of ${of}`)] }
		}
		entries[id] = entry
	}
	return { ok: true, value: entries }
}

/** `export const <members, invitations, links or refusals> = { '<endpoint id>': ['<field>', …] }`, read into lists. */
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
			const of = name === REFUSALS_EXPORT ? 'error types' : 'input field names'
			return { ok: false, findings: [finding(init, `the ${name} of ${id} is not a list of ${of}`)] }
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
			|| (name !== FIXTURES_EXPORT && name !== SEEDS_EXPORT && name !== ROWS_EXPORT && name !== APP_ROWS_EXPORT && name !== FILES_EXPORT
				&& !isFieldExport(name))
			|| read.has(name)
			|| (isFieldExport(name) && fields.has(name))
		) {
			return {
				ok: false,
				findings: [
					finding(
						statement ?? undefined,
						`the file holds export const ${FIXTURES_EXPORT}, ${SEEDS_EXPORT}, ${MEMBERS_EXPORT}, ${INVITATIONS_EXPORT}, ${LINKS_EXPORT}, ${ROWS_EXPORT}, ${APP_ROWS_EXPORT}, ${FILES_EXPORT} and ${REFUSALS_EXPORT} = { … }, each at most once`,
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
		if (name === ROWS_EXPORT) {
			const named = Object.entries(value.value).find(([, fields]) => Object.values(fields).some((table) => typeof table !== 'string'))
			if (named !== undefined) {
				return { ok: false, findings: [finding(child(declarator, 'init'), `the rows of ${named[0]} name each field's table as a string`)] }
			}
		}
		if (name === FILES_EXPORT) {
			const named = Object.entries(value.value).find(([, fields]) => Object.values(fields).some((path) => typeof path !== 'string'))
			if (named !== undefined) {
				return { ok: false, findings: [finding(child(declarator, 'init'), `the files of ${named[0]} name each field's file as a path string`)] }
			}
		}
		if (name === APP_ROWS_EXPORT) {
			const named = Object.entries(value.value).find(([, tables]) => Object.values(tables).some((columns) => !isSampleObject(columns)))
			if (named !== undefined) {
				return { ok: false, findings: [finding(child(declarator, 'init'), `the appRows of ${named[0]} give each table's row as an object of columns`)] }
			}
		}
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
			refusals: fields.get(REFUSALS_EXPORT) ?? {},
			rows: Object.fromEntries(
				Object.entries(read.get(ROWS_EXPORT) ?? {}).map(([id, named]) => [
					id,
					Object.fromEntries(Object.entries(named).flatMap(([field, table]) => (typeof table === 'string' ? [[field, table]] : []))),
				]),
			),
			appRows: Object.fromEntries(
				Object.entries(read.get(APP_ROWS_EXPORT) ?? {}).map(([id, tables]) => [
					id,
					Object.fromEntries(Object.entries(tables).flatMap(([table, columns]) => (isSampleObject(columns) ? [[table, columns]] : []))),
				]),
			),
			files: Object.fromEntries(
				Object.entries(read.get(FILES_EXPORT) ?? {}).map(([id, named]) => [
					id,
					Object.fromEntries(Object.entries(named).flatMap(([field, path]) => (typeof path === 'string' ? [[field, path]] : []))),
				]),
			),
		},
	}
}
