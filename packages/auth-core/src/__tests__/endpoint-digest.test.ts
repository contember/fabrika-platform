import { describe, expect, test } from 'bun:test'
import type { CredentialedEndpoint, EndpointRow } from '../contract'
import {
	contractDigest,
	type EndpointDelegation,
	endpointDelegation,
	endpointDigest,
	exportDigest,
	formatEndpointHeader,
	isDigest,
	parseEndpointHeader,
	requirementDigest,
} from '../endpoint-digest'
import type { InstallationCredentialedEndpoint } from '../installation-endpoint'
import { notesArtifact } from './fixtures/notes-artifact'

type Rules = EndpointRow & { readonly delegation: EndpointDelegation | null }

const row: CredentialedEndpoint & { readonly delegation: EndpointDelegation | null } = {
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
	delegation: null,
}

describe('requirementDigest', () => {
	test('is a sha256 digest and is stable', () => {
		expect(isDigest(requirementDigest(row))).toBe(true)
		expect(requirementDigest({ ...row })).toBe(requirementDigest(row))
	})

	test.each<[string, Rules]>([
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
		['only the delegation, to members', { ...row, delegation: 'members' }],
		['only the delegation, to creates', { ...row, delegation: 'creates' }],
	])('changes when %s changes', (_name, changed) => {
		expect(requirementDigest(changed)).not.toBe(requirementDigest(row))
	})

	test('ignores caller and content-type order, schemas, the source and the id', () => {
		const reordered: Rules = {
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

describe('an application row keeps its digest byte for byte', () => {
	// Recorded before installation rows existed: a proxy that changed one would answer 503 to an unchanged application.
	const RECORDED: Readonly<Record<string, string>> = {
		'api.me': 'sha256:f3520c5f8d3aac6a513c85955fc80df9d96bd274d7622b535ddf626dd727993b',
		'api.notes.list': 'sha256:7f19734a6423280509d19742686a24b0e7fc9988c7d2fabc631d0c02707d4357',
		'api.notes.remove': 'sha256:76f1c83753e66a473164ddf38a4dd2104b19b6a85e4271653787c0b9fa83d67d',
		'api.workspaces.create': 'sha256:34ee737b30f3a319b06ec2e3b07969b188dd8a5382b2a07914b71ad17b935377',
		'machine.importNotes': 'sha256:f869a65ae9716c34f665604c6239ea05c85ecf4c095dc45cb1a9be4f77662281',
		'files.attachments.download': 'sha256:a9e064275d755313cfcb417aee0d6e3265f171002ecad0e831a8f40160cd7cdf',
		shared: 'sha256:8d500123a497a95e8f0887c468e70c62f78e7f3e8e2d69753aa7ea054f3ddcab',
		'shared.note': 'sha256:7ab06754abe0fc67d597729d9d361fbb7aa0b6a788b248186f0b2cf9defe5e8f',
		health: 'sha256:f180f636975e69016cea9bf60a44f559f8c5b00572f70903979674bf936c086f',
		github: 'sha256:229adc2a88ead1f8339c1011bd25edf9b5f36c87ce4baeb206426ce32ea644d2',
		contact: 'sha256:efb169deafb5b76cab8f703afd28f1717c327f9aa18d915570f338bb1b9bc1f5',
		'products.v1': 'sha256:f0f22a05c6ed25d2d4aa106439aeb3cd20a3b4705f7fbfa30f70f203c0480437',
		'products.v1.get': 'sha256:b6be4a2f5cddea9e794af62d53ed984c01cd0cb31b2293e0ce41b34f7a92db07',
		spa: 'sha256:5accf6e8b1921c5fb3cb84af6dc8f7614ac5859232795f23cfa908b7655ae6f1',
	}

	test('every endpoint of the notes artifact, and the contract digest', () => {
		expect(Object.fromEntries(notesArtifact.endpoints.map((endpoint) => [endpoint.id, endpointDigest(notesArtifact, endpoint)]))).toEqual(RECORDED)
		expect(contractDigest(notesArtifact)).toBe('sha256:aef0ee6909bbca73aa8773febd566301d5c4f096b9b24f69a8e006f3f364c65c')
	})
})

describe('an installation row', () => {
	const mcp: InstallationCredentialedEndpoint & { readonly delegation: null } = {
		id: 'mcp',
		kind: 'service',
		method: '*',
		path: '/mcp',
		callers: ['oauth'],
		requirement: { kind: 'authenticated' },
		admission: null,
		oauth: { scopes: ['authoring', 'deploy'] },
		delegation: null,
	}

	test('its OAuth scopes are part of the digest, in no order', () => {
		expect(requirementDigest({ ...mcp, oauth: { scopes: ['deploy', 'authoring'] } })).toBe(requirementDigest(mcp))
		expect(requirementDigest({ ...mcp, oauth: { scopes: ['authoring'] } })).not.toBe(requirementDigest(mcp))
		expect(requirementDigest({ ...mcp, oauth: null, callers: ['human'] })).not.toBe(requirementDigest({ ...mcp, callers: ['human'] }))
	})

	test('its method, kind, callers and requirement are part of the digest', () => {
		expect(requirementDigest({ ...mcp, method: 'POST' })).not.toBe(requirementDigest(mcp))
		expect(requirementDigest({ ...mcp, callers: ['oauth', 'machine'] })).not.toBe(requirementDigest(mcp))
		const protocol = { ...mcp, kind: 'protocol', callers: [], requirement: null, oauth: null } as const
		expect(requirementDigest(protocol)).not.toBe(requirementDigest({ ...protocol, kind: 'health' }))
	})
})

describe('endpointDelegation and endpointDigest', () => {
	const invite: EndpointRow = {
		...row,
		id: 'api.workspaces.invite',
		requirement: { kind: 'action', action: 'notes.admin', access: { form: 'in', dimension: 'workspace', from: 'workspaceId' } },
	}
	const create = notesArtifact.endpoints.find((endpoint) => endpoint.id === 'api.workspaces.create')

	test('creates for a creating endpoint, members for the dimension members.manage action, none otherwise', () => {
		expect(create === undefined ? 'missing' : endpointDelegation(notesArtifact, create)).toBe('creates')
		expect(endpointDelegation(notesArtifact, invite)).toBe('members')
		expect(endpointDelegation(notesArtifact, row)).toBeNull()
		expect(endpointDelegation(notesArtifact, { ...invite, requirement: { kind: 'member' } })).toBeNull()
	})

	test('a delegation-only change of the contract changes the endpoint digest', () => {
		const unmanaged = { ...notesArtifact, dimensions: { ...notesArtifact.dimensions, workspace: { in: null, creator: 'owner', members: null } } }
		expect(endpointDigest(unmanaged, invite)).not.toBe(endpointDigest(notesArtifact, invite))
		expect(endpointDigest(notesArtifact, invite)).toBe(requirementDigest({ ...invite, delegation: 'members' }))
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

describe('exportDigest', () => {
	const sku = { type: 'enum', values: ['a', 'b'] } as const
	const description = {
		app: 'catalog',
		export: 'products',
		version: 1,
		audience: 'any consumer user',
		procedures: { get: { input: { type: 'object', fields: { sku } }, output: { type: 'boolean' } } },
	} as const

	test('is a digest, and key and enum order do not change it', () => {
		const reordered = {
			procedures: { get: { output: { type: 'boolean' }, input: { fields: { sku: { values: ['b', 'a'], type: 'enum' } }, type: 'object' } } },
			audience: 'any consumer user',
			version: 1,
			export: 'products',
			app: 'catalog',
		} as const
		expect(isDigest(exportDigest(description))).toBe(true)
		expect(exportDigest(reordered)).toBe(exportDigest(description))
	})

	test('a changed schema, version or audience changes it', () => {
		const digest = exportDigest(description)
		expect(exportDigest({ ...description, version: 2 })).not.toBe(digest)
		expect(exportDigest({ ...description, audience: 'someone else' })).not.toBe(digest)
		expect(exportDigest({ ...description, procedures: { get: { input: null, output: { type: 'boolean' } } } })).not.toBe(digest)
	})
})
