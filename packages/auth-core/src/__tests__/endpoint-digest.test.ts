import { describe, expect, test } from 'bun:test'
import type { CredentialedEndpoint, EndpointRow } from '../contract'
import { contractDigest, formatEndpointHeader, isDigest, parseEndpointHeader, requirementDigest } from '../endpoint-digest'
import { notesArtifact } from './fixtures/notes-artifact'

const row: CredentialedEndpoint = {
	id: 'api.notes.remove',
	source: { kind: 'mount', name: 'api' },
	kind: 'mutation',
	method: 'POST',
	path: '/api/notes.remove',
	callers: ['human', 'machine'],
	requirement: { kind: 'action', action: 'notes.delete', access: { form: 'on', dimension: 'note', from: 'id' } },
	admission: { contentTypes: ['application/json', 'text/plain'], maxBytes: 1024 },
	input: null,
	output: null,
}

describe('requirementDigest', () => {
	test('is a sha256 digest and is stable', () => {
		expect(isDigest(requirementDigest(row))).toBe(true)
		expect(requirementDigest({ ...row })).toBe(requirementDigest(row))
	})

	test.each<[string, EndpointRow]>([
		['the kind', { ...row, kind: 'query' }],
		['the method', { ...row, method: 'GET' }],
		['the path', { ...row, path: '/api/notes.delete' }],
		['a caller added', { ...row, callers: ['human', 'machine', 'link'] }],
		['a caller removed', { ...row, callers: ['human'] }],
		['the requirement kind', { ...row, requirement: { kind: 'member' } }],
		['the action', { ...row, requirement: { kind: 'action', action: 'notes.write', access: { form: 'on', dimension: 'note', from: 'id' } } }],
		['the access form', { ...row, requirement: { kind: 'action', action: 'notes.delete', access: { form: 'over', dimension: 'note' } } }],
		['the access dimension', {
			...row,
			requirement: { kind: 'action', action: 'notes.delete', access: { form: 'on', dimension: 'workspace', from: 'id' } },
		}],
		['the access field', { ...row, requirement: { kind: 'action', action: 'notes.delete', access: { form: 'on', dimension: 'note', from: null } } }],
		['a content type', { ...row, admission: { contentTypes: ['application/json'], maxBytes: 1024 } }],
		['the body limit', { ...row, admission: { contentTypes: ['application/json', 'text/plain'], maxBytes: null } }],
		['the admission removed', { ...row, admission: null }],
		['the row made anonymous', { ...row, kind: 'health', callers: [], requirement: null }],
	])('changes when %s changes', (_name, changed) => {
		expect(requirementDigest(changed)).not.toBe(requirementDigest(row))
	})

	test('ignores caller and content-type order, schemas, the source and the id', () => {
		const reordered: CredentialedEndpoint = {
			...row,
			id: 'other',
			source: { kind: 'export', name: 'x' },
			callers: ['machine', 'human'],
			admission: { contentTypes: ['text/plain', 'application/json'], maxBytes: 1024 },
			input: { type: 'boolean' },
			output: { type: 'null' },
		}
		expect(requirementDigest(reordered)).toBe(requirementDigest(row))
	})
})

describe('contractDigest', () => {
	test('changes with any endpoint row and ignores declaration order', () => {
		const digest = contractDigest(notesArtifact)
		expect(isDigest(digest)).toBe(true)
		expect(contractDigest({ ...notesArtifact, endpoints: [...notesArtifact.endpoints].reverse() })).toBe(digest)
		expect(contractDigest({ ...notesArtifact, endpoints: notesArtifact.endpoints.slice(1) })).not.toBe(digest)
		expect(contractDigest({ ...notesArtifact, actions: { ...notesArtifact.actions, 'notes.extra': 'x' } })).not.toBe(digest)
	})
})

describe('the endpoint header', () => {
	test('round-trips an id and a digest', () => {
		const digest = requirementDigest(row)
		expect(parseEndpointHeader(formatEndpointHeader(row.id, digest))).toEqual({ id: row.id, digest })
	})

	test.each(['', 'api.me', '@sha256:' + 'a'.repeat(64), 'api.me@sha256:' + 'A'.repeat(64), 'api.me@sha256:abc', 'api.me@md5:' + 'a'.repeat(64)])(
		'refuses %j',
		(value) => {
			expect(parseEndpointHeader(value)).toBeNull()
		},
	)
})
