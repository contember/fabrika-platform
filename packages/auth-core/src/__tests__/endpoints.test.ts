import { describe, expect, test } from 'bun:test'
import type { EndpointRow, EndpointTable } from '../contract'
import { assertNoAmbiguity, compileEndpointTable, EndpointTableError, orderBySpecificity, planEndpoint, selectableRows } from '../endpoints'
import { notesArtifact } from './fixtures/notes-artifact'

const row = (id: string, method: 'GET' | 'POST', path: string): EndpointRow => ({
	id,
	source: { kind: 'mount', name: id },
	kind: method === 'GET' ? 'download' : 'mutation',
	method,
	path,
	callers: ['human'],
	requirement: { kind: 'member' },
	admission: null,
	input: null,
	output: null,
})

const table = (endpoints: EndpointRow[], reservedPrefixes: string[] = []): EndpointTable => ({ endpoints, reservedPrefixes })

const notes = compileEndpointTable(notesArtifact)

/** The selected endpoint id, or the outcome when nothing is selected. */
const plan = (method: string, path: string, compiled = notes): string => {
	const result = planEndpoint(compiled, method, path)
	return result.outcome === 'endpoint' ? result.endpoint.id : result.outcome
}

describe('planEndpoint refuses a non-canonical path before selecting', () => {
	test.each([
		['//api/notes.list'],
		['/api//notes.list'],
		['/a/../api/notes.list'],
		['/a/%2e%2e/api/notes.list'],
		['/api/./notes.list'],
		['/api%2Fnotes.list'],
		['/api%5Cnotes.list'],
		['/api\\notes.list'],
		['api/notes.list'],
		[''],
		['/api/files.attachments/%FF'],
		['/api/files.attachments/%'],
	])('%p', (path) => {
		expect(plan('POST', path)).toBe('non-canonical')
	})
})

describe('planEndpoint selects no endpoint', () => {
	test.each([
		['an unknown procedure under an RPC prefix, which the SPA must not serve', 'GET', '/api/notes.export'],
		['an unknown procedure posted under an RPC prefix', 'POST', '/api/notes.export'],
		['the empty procedure name', 'GET', '/api/'],
		['a procedure with the wrong method', 'GET', '/api/notes.list'],
		['a path below a procedure', 'POST', '/api/notes.list/x'],
		['a procedure of another case', 'POST', '/API/notes.list'],
		['an encoded procedure name, compared raw', 'POST', '/api/notes%2Elist'],
		['a link procedure path the link SPA must not serve', 'GET', '/s/api/note'],
		['an unknown connector procedure', 'POST', '/__fabrika/connect/products.v1.list'],
		['a POST outside every procedure', 'POST', '/'],
		['a method no row has', 'DELETE', '/api/notes.remove'],
		['a lowercase method', 'post', '/api/notes.remove'],
		['an empty parameter', 'GET', '/api/files.attachments/'],
		['a webhook without its binding', 'POST', '/hooks/github'],
		['a webhook with a trailing slash and no binding', 'POST', '/hooks/github/'],
	])('%s', (_name, method, path) => {
		expect(plan(method, path)).toBe('no-endpoint')
	})

	test('an empty table selects nothing', () => {
		expect(plan('GET', '/', compileEndpointTable(table([])))).toBe('no-endpoint')
	})
})

describe('planEndpoint selects the declared endpoint', () => {
	test.each([
		['POST', '/api/me', 'api.me'],
		['POST', '/api/notes.remove', 'api.notes.remove'],
		['POST', '/machine/importNotes', 'machine.importNotes'],
		['GET', '/api/files.attachments/f1', 'files.attachments.download'],
		['POST', '/s/api/note', 'shared.note'],
		['GET', '/s/', 'shared'],
		['GET', '/s/index.html', 'shared'],
		['GET', '/healthz', 'health'],
		['POST', '/hooks/github/b1', 'github'],
		['POST', '/contact', 'contact'],
		['POST', '/__fabrika/connect/products.v1.get', 'products.v1.get'],
		['GET', '/', 'spa'],
		['GET', '/notes/n1', 'spa'],
		['GET', '/api', 'spa'],
		['GET', '/healthz/', 'spa'],
		['GET', '/s', 'spa'],
	])('%s %s → %s', (method, path, id) => {
		expect(plan(method, path)).toBe(id)
	})

	test('parameters are returned raw, still percent-encoded', () => {
		const result = planEndpoint(notes, 'GET', '/api/files.attachments/a%20b')
		expect(result.outcome === 'endpoint' && result.params).toEqual({ fileId: 'a%20b' })
	})

	test('parameters are own data properties', () => {
		const result = planEndpoint(compileEndpointTable(table([row('p', 'GET', '/x/:hasOwnProperty/:toString')])), 'GET', '/x/a/b')
		expect(result.outcome === 'endpoint' && Object.entries(result.params)).toEqual([['hasOwnProperty', 'a'], ['toString', 'b']])
	})

	test('a wildcard binds no parameter', () => {
		const result = planEndpoint(notes, 'GET', '/s/a/b')
		expect(result.outcome === 'endpoint' && result.params).toEqual({})
	})
})

describe('specificity: a literal beats a parameter, a parameter beats a wildcard', () => {
	const files = compileEndpointTable(table([
		row('wildcard', 'GET', '/files/*'),
		row('param', 'GET', '/files/:id'),
		row('literal', 'GET', '/files/latest'),
		row('root', 'GET', '/*'),
		row('index', 'GET', '/'),
	]))

	test.each([
		['/files/latest', 'literal'],
		['/files/f1', 'param'],
		['/files/f1/raw', 'wildcard'],
		['/files/', 'wildcard'],
		['/files', 'root'],
		['/', 'index'],
		['/other', 'root'],
	])('%s → %s', (path, id) => {
		expect(plan('GET', path, files)).toBe(id)
	})

	test('the first differing segment decides, left to right', () => {
		const crossed = compileEndpointTable(table([row('late', 'GET', '/a/:x/b'), row('early', 'GET', '/a/b/:y')]))
		expect(plan('GET', '/a/b/b', crossed)).toBe('early')
		expect(plan('GET', '/a/c/b', crossed)).toBe('late')
	})

	test('a trailing slash is a literal segment', () => {
		const slash = compileEndpointTable(table([row('bare', 'GET', '/a'), row('slash', 'GET', '/a/'), row('param', 'GET', '/a/:x')]))
		expect(plan('GET', '/a', slash)).toBe('bare')
		expect(plan('GET', '/a/', slash)).toBe('slash')
		expect(plan('GET', '/a/x', slash)).toBe('param')
		expect(plan('GET', '/a/x/', slash)).toBe('no-endpoint')
	})

	test('the same path with another method is another endpoint', () => {
		const methods = compileEndpointTable(table([row('read', 'GET', '/x/:id'), row('write', 'POST', '/x/:id')]))
		expect(plan('GET', '/x/1', methods)).toBe('read')
		expect(plan('POST', '/x/1', methods)).toBe('write')
	})
})

describe('reserved prefixes', () => {
	test('the longest reserved prefix decides which endpoints may serve a path', () => {
		const nested = compileEndpointTable(table(
			[row('spa', 'GET', '/*'), row('link', 'GET', '/s/*'), row('proc', 'GET', '/s/api/note')],
			['/s/api'],
		))
		expect(plan('GET', '/s/api/note', nested)).toBe('proc')
		expect(plan('GET', '/s/api/other', nested)).toBe('no-endpoint')
		expect(plan('GET', '/s/other', nested)).toBe('link')
	})

	test('an endpoint outside the prefix never serves under it, however it matches', () => {
		const shadow = compileEndpointTable(table([row('param', 'POST', '/:mount/notes.list')], ['/api']))
		expect(plan('POST', '/api/notes.list', shadow)).toBe('no-endpoint')
		expect(plan('POST', '/other/notes.list', shadow)).toBe('param')
	})
})

describe('assertNoAmbiguity', () => {
	const problems = (subject: EndpointTable): string[] => {
		try {
			assertNoAmbiguity(subject)
		} catch (error) {
			if (error instanceof EndpointTableError) return [...error.problems]
			throw error
		}
		return []
	}

	test('accepts the notes artifact', () => {
		expect(problems(notesArtifact)).toEqual([])
	})

	test('refuses two endpoints of one method and one shape', () => {
		expect(problems(table([row('a', 'GET', '/x/:id'), row('b', 'GET', '/x/:other')]))).toEqual([
			"'b' and 'a' both serve GET /x/:other",
		])
		expect(problems(table([row('a', 'POST', '/x'), row('b', 'POST', '/x')]))).toEqual(["'b' and 'a' both serve POST /x"])
		expect(problems(table([row('a', 'GET', '/x/*'), row('b', 'GET', '/x/*')]))).toEqual(["'b' and 'a' both serve GET /x/*"])
	})

	test('accepts overlapping endpoints that specificity orders', () => {
		expect(problems(table([row('a', 'GET', '/x/:id'), row('b', 'GET', '/x/latest'), row('c', 'GET', '/x/*'), row('d', 'POST', '/x/:id')]))).toEqual(
			[],
		)
		expect(problems(table([row('a', 'GET', '/a/:x/b'), row('b', 'GET', '/a/b/:y')]))).toEqual([])
		expect(problems(table([row('a', 'GET', '/a'), row('b', 'GET', '/a/')]))).toEqual([])
	})

	test('refuses a duplicate id', () => {
		expect(problems(table([row('a', 'GET', '/x'), row('a', 'GET', '/y')]))).toEqual(["endpoint id 'a' is declared twice"])
	})

	test.each([
		['', "endpoint 'e' has path '': not a canonical path"],
		['x', "endpoint 'e' has path 'x': not a canonical path"],
		['/a//b', "endpoint 'e' has path '/a//b': not a canonical path"],
		['/a/../b', "endpoint 'e' has path '/a/../b': not a canonical path"],
		['/a/*/b', "endpoint 'e' has path '/a/*/b': '*' must be the last segment"],
		['/a/*/', "endpoint 'e' has path '/a/*/': '*' must be the last segment"],
		['/a/*x', "endpoint 'e' has path '/a/*x': '*' must be a whole segment"],
		['/a/x*', "endpoint 'e' has path '/a/x*': '*' must be a whole segment"],
		['/a/:', "endpoint 'e' has path '/a/:': ':' must start a parameter name of letters, digits and '_'"],
		['/a/:1x', "endpoint 'e' has path '/a/:1x': ':' must start a parameter name of letters, digits and '_'"],
		['/a/:x-y', "endpoint 'e' has path '/a/:x-y': ':' must start a parameter name of letters, digits and '_'"],
		['/:x/:x', "endpoint 'e' has path '/:x/:x': parameter 'x' is declared twice"],
		['/a/:__proto__', "endpoint 'e' has path '/a/:__proto__': '__proto__' is not allowed as a parameter name"],
		['/a/:constructor', "endpoint 'e' has path '/a/:constructor': 'constructor' is not allowed as a parameter name"],
		['/a/:prototype', "endpoint 'e' has path '/a/:prototype': 'prototype' is not allowed as a parameter name"],
		['/a/%FF', "endpoint 'e' has path '/a/%FF': not a canonical path"],
	])('refuses the path %p', (path, problem) => {
		expect(problems(table([row('e', 'GET', path)]))).toEqual([problem])
	})

	test.each([
		['/', "reserved prefix '/' must be a literal path below the root, without a trailing '/'"],
		['/api/', "reserved prefix '/api/' must be a literal path below the root, without a trailing '/'"],
		['/api/:x', "reserved prefix '/api/:x' must be a literal path below the root, without a trailing '/'"],
		['/api/*', "reserved prefix '/api/*' must be a literal path below the root, without a trailing '/'"],
		['/a//b', "reserved prefix '/a//b' must be a literal path below the root, without a trailing '/'"],
		['api', "reserved prefix 'api' must be a literal path below the root, without a trailing '/'"],
	])('refuses the reserved prefix %p', (prefix, problem) => {
		expect(problems(table([], [prefix]))).toEqual([problem])
	})

	test('refuses a duplicate reserved prefix', () => {
		expect(problems(table([], ['/api', '/api']))).toEqual(["reserved prefix '/api' is declared twice"])
	})

	test('lists every problem at once', () => {
		expect(problems(table([row('a', 'GET', '/x//'), row('a', 'GET', '/y')], ['/']))).toHaveLength(3)
	})

	test('compileEndpointTable refuses the same tables', () => {
		expect(() => compileEndpointTable(table([row('a', 'GET', '/x/:a'), row('b', 'GET', '/x/:b')]))).toThrow(EndpointTableError)
	})
})

describe('orderBySpecificity', () => {
	test('orders most specific first, keeping declaration order between paths that never overlap', () => {
		const rows = [
			row('root', 'GET', '/*'),
			row('w', 'GET', '/a/*'),
			row('p', 'GET', '/a/:x'),
			row('b', 'GET', '/b'),
			row('l', 'GET', '/a/l'),
			row('i', 'GET', '/'),
		]
		expect(orderBySpecificity(rows).map(({ id }) => id)).toEqual(['i', 'b', 'l', 'p', 'w', 'root'])
	})

	test('refuses an invalid path', () => {
		expect(() => orderBySpecificity([row('e', 'GET', '/a/*/b')])).toThrow(EndpointTableError)
	})
})

describe('selectableRows: what a method-blind gate at one path must admit', () => {
	const ids = (rows: readonly EndpointRow[]) => rows.map(({ id }) => id)

	test('a row of the method at the same path shape is the only answer', () => {
		const rows = table([row('get', 'GET', '/a/:x'), row('post', 'POST', '/a/:y'), row('any', 'POST', '/*')])
		expect(ids(selectableRows(rows, '/a/:x', 'POST'))).toEqual(['post'])
		expect(ids(selectableRows(rows, '/a/:y', 'GET'))).toEqual(['get'])
	})

	test('without one, every overlapping row of the method that is not more specific', () => {
		const rows = table([
			row('form', 'POST', '/contact'),
			row('spa', 'GET', '/*'),
			row('param', 'GET', '/:page'),
			row('narrower', 'GET', '/contact/x'),
			row('other', 'GET', '/about'),
		])
		expect(ids(selectableRows(rows, '/contact', 'GET'))).toEqual(['spa', 'param'])
		expect(ids(selectableRows(rows, '/contact', 'POST'))).toEqual(['form'])
	})

	test('no row of a method that the path cannot reach', () => {
		expect(selectableRows(table([row('get', 'GET', '/a')]), '/b', 'GET')).toEqual([])
		expect(selectableRows(table([row('slash', 'GET', '/a/')]), '/a/:x', 'GET')).toEqual([])
		expect(selectableRows(table([row('w', 'GET', '/a/*')]), '/a', 'GET')).toEqual([])
		expect(ids(selectableRows(table([row('w', 'GET', '/a/*')]), '/a/', 'GET'))).toEqual(['w'])
		expect(ids(selectableRows(table([row('root', 'GET', '/*')]), '/', 'GET'))).toEqual(['root'])
	})

	test('under a reserved prefix only the rows declared under it compete', () => {
		const rows = table([row('spa', 'GET', '/*'), row('procedure', 'POST', '/api/notes.list'), row('file', 'GET', '/api/files/:id')], ['/api'])
		expect(selectableRows(rows, '/api/notes.list', 'GET')).toEqual([])
		expect(ids(selectableRows(rows, '/api/files/:id', 'GET'))).toEqual(['file'])
	})

	test('refuses an invalid path', () => {
		expect(() => selectableRows(table([]), '/a/*/b', 'GET')).toThrow(EndpointTableError)
	})
})
