import { describe, expect, test } from 'bun:test'
import type { EndpointMethod, EndpointRow } from '../contract'
import { compileEndpointTable, orderBySpecificity, planEndpoint } from '../endpoints'
import { applicableGates, compileGates } from '../gates'
import { probesFor } from './fixtures/gate-probes'
import { notesArtifact } from './fixtures/notes-artifact'

// Part A generates one gate per endpoint path in specificity order. The proxy then admits a path by the first
// matching gate, and the framework selects by the table; both must name the same row.

const row = (id: string, path: string, method: EndpointMethod = 'GET'): EndpointRow => ({
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

function decisions(rows: readonly EndpointRow[], reservedPrefixes: readonly string[], method: EndpointMethod, probes: readonly string[]) {
	const ofMethod = rows.filter((candidate) => candidate.method === method)
	const gates = compileGates({ rules: orderBySpecificity(ofMethod).map(({ path }) => ({ path, kind: 'public' })) })
	const byPath = new Map(ofMethod.map((candidate) => [candidate.path, candidate.id]))
	const table = compileEndpointTable({ endpoints: rows, reservedPrefixes })
	return probes.map((path) => {
		const gate = applicableGates(gates, path)[0]
		const plan = planEndpoint(table, method, path)
		return {
			path,
			gate: gate === undefined ? null : (byPath.get(gate.rule.path) ?? null),
			table: plan.outcome === 'endpoint' ? plan.endpoint.id : null,
		}
	})
}

const tables: [string, EndpointRow[]][] = [
	['literal, parameter, wildcard and root', [row('w', '/files/*'), row('p', '/files/:id'), row('l', '/files/latest'), row('r', '/*'), row('i', '/')]],
	['crossed parameters', [row('late', '/a/:x/b'), row('early', '/a/b/:y')]],
	['trailing slashes', [row('bare', '/a'), row('slash', '/a/'), row('p', '/a/:x'), row('ps', '/a/:x/')]],
	['parameters before wildcards', [row('a', '/a/:x/*'), row('b', '/a/:x/c'), row('c', '/a/b/*'), row('d', '/:x'), row('e', '/:x/:y/z')]],
	['the notes contract', [...notesArtifact.endpoints]],
]

describe('generated gates and planEndpoint select the same row', () => {
	for (const [name, rows] of tables) {
		for (const method of ['GET', 'POST'] as const) {
			test(`${name}, ${method}`, () => {
				const results = decisions(rows, [], method, probesFor(rows))
				expect(results.length).toBeGreaterThan(10)
				expect(results.filter((result) => result.gate !== result.table)).toEqual([])
			})
		}
	}

	test('a parameter gate admits one non-empty segment, exactly like the endpoint', () => {
		const rows = [row('p', '/files/:id')]
		expect(decisions(rows, [], 'GET', ['/files/a', '/files/', '/files/a/b', '/files'])).toEqual([
			{ path: '/files/a', gate: 'p', table: 'p' },
			{ path: '/files/', gate: null, table: null },
			{ path: '/files/a/b', gate: null, table: null },
			{ path: '/files', gate: null, table: null },
		])
	})
})

describe('under a reserved prefix the part-A gates are coarser than the table', () => {
	const rows = notesArtifact.endpoints
	const prefixes = notesArtifact.reservedPrefixes
	const isReserved = (path: string) => prefixes.some((prefix) => path.startsWith(`${prefix}/`))

	test('an unknown procedure is admitted at the gate with the SPA kind and refused by the table', () => {
		expect(decisions(rows, prefixes, 'GET', ['/api/notes.export', '/s/api/other'])).toEqual([
			{ path: '/api/notes.export', gate: 'spa', table: null },
			{ path: '/s/api/other', gate: 'shared', table: null },
		])
	})

	for (const method of ['GET', 'POST'] as const) {
		test(`outside every reserved prefix the two still agree, ${method}`, () => {
			const results = decisions(rows, prefixes, method, probesFor(rows).filter((path) => !isReserved(path)))
			expect(results.filter((result) => result.gate !== result.table)).toEqual([])
		})

		test(`under a reserved prefix the table refuses or agrees, never selects another row, ${method}`, () => {
			const results = decisions(rows, prefixes, method, probesFor(rows).filter(isReserved))
			expect(results.length).toBeGreaterThan(0)
			expect(results.filter((result) => result.table !== null && result.table !== result.gate)).toEqual([])
		})
	}
})
