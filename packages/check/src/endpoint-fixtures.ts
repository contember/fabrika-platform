// `src/__tests__/endpoint-access.fixtures.ts`: the inputs an application's author gives the endpoint access tests
// where the scaffold cannot sample one (a `regex`). Read from source, never executed, within the reader's budget:
// `export const fixtures = { '<endpoint id>': { … } }`, plain literals only. Browser-safe.

import { type AstNode, child, children, identifierName, nodeDepth, parseModule, positionOf, staticKey, staticString } from './ast'
import type { Finding } from './finding'
import { ENDPOINT_FIXTURES_FILE } from './layout'
import { CONTRACT_LIMITS } from './limits'
import type { Sample } from './scaffold-sample'

export const FIXTURES_EXPORT = 'fixtures'

const ALLOWED = "export const fixtures = { 'api.notes.get': { id: '…' } }: string keys, and strings, numbers, booleans, null, arrays and objects"

export type EndpointFixtures = Readonly<Record<string, Readonly<Record<string, Sample>>>>

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

/** The fixtures of `files`, by endpoint id; none without the file. */
export function readEndpointFixtures(
	files: ReadonlyMap<string, string>,
): { readonly ok: true; readonly fixtures: EndpointFixtures } | { readonly ok: false; readonly findings: readonly Finding[] } {
	const text = files.get(ENDPOINT_FIXTURES_FILE)
	if (text === undefined) return { ok: true, fixtures: {} }
	if (new TextEncoder().encode(text).byteLength > CONTRACT_LIMITS.sourceBytes) {
		return { ok: false, findings: [finding(undefined, `the fixtures exceed ${CONTRACT_LIMITS.sourceBytes} bytes`)] }
	}
	const parsed = parseModule(ENDPOINT_FIXTURES_FILE, text)
	if (!parsed.ok) return { ok: false, findings: [finding(undefined, parsed.message)] }
	const program = parsed.module.program
	if (nodeDepth(program) > CONTRACT_LIMITS.astDepth) {
		return { ok: false, findings: [finding(undefined, `the fixtures nest deeper than ${CONTRACT_LIMITS.astDepth}`)] }
	}
	const body = children(program, 'body')
	const declaration = body.length === 1 ? child(body[0] ?? { type: '' }, 'declaration') : undefined
	const declarators = declaration?.type === 'VariableDeclaration' && declaration['kind'] === 'const' ? children(declaration, 'declarations') : []
	const declarator = declarators.length === 1 ? declarators[0] : undefined
	if (
		body[0]?.type !== 'ExportNamedDeclaration' || declarator === null || declarator === undefined
		|| identifierName(child(declarator, 'id')) !== FIXTURES_EXPORT
	) {
		return { ok: false, findings: [finding(body[0] ?? undefined, `the file holds one statement, export const ${FIXTURES_EXPORT} = { … }`)] }
	}
	const value = literal(child(declarator, 'init'))
	if (!value.ok) return { ok: false, findings: [finding(value.at, 'not a plain literal')] }
	const all = value.value
	if (!isSampleObject(all)) {
		return { ok: false, findings: [finding(child(declarator, 'init'), 'the fixtures are an object keyed by endpoint id')] }
	}
	const fixtures: Record<string, Readonly<Record<string, Sample>>> = {}
	for (const [id, input] of Object.entries(all)) {
		if (!isSampleObject(input)) {
			return { ok: false, findings: [finding(child(declarator, 'init'), `the fixture of ${id} is not an object of input fields`)] }
		}
		fixtures[id] = input
	}
	return { ok: true, fixtures }
}
