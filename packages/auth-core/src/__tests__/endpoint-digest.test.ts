import { describe, expect, test } from 'bun:test'
import type { CredentialedEndpoint, EndpointRow } from '../contract'
import {
	contractDigest,
	type EndpointDelegation,
	endpointDelegation,
	endpointDigest,
	exportDigest,
	formatEndpointHeader,
	installationTableDigest,
	isDigest,
	parseEndpointHeader,
	requirementDigest,
} from '../endpoint-digest'
import type { InstallationAnonymousEndpoint, InstallationCredentialedEndpoint } from '../installation-endpoint'
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
		["the endpoint opened to the environment's origins", { ...row, crossOrigin: 'environment' }],
		['the endpoint opened to any origin', { ...row, crossOrigin: 'any' }],
		['the answer made a stored file', { ...row, response: 'file' }],
	])('changes when %s changes', (_name, changed) => {
		expect(requirementDigest(changed)).not.toBe(requirementDigest(row))
	})

	test('keeps the digest of a row that answers no file, so every older row keeps its own', () => {
		expect(requirementDigest({ ...row, response: undefined })).toBe(requirementDigest(row))
	})

	test('tells the two cross-origin forms apart, and an absent one from neither', () => {
		const environment = requirementDigest({ ...row, crossOrigin: 'environment' })
		expect(requirementDigest({ ...row, crossOrigin: 'any' })).not.toBe(environment)
		expect(requirementDigest({ ...row, crossOrigin: undefined })).toBe(requirementDigest(row))
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
	// The export rows were recorded again when their callers lost `machine` (B9b); the fixture changed, not the digest.
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
		'products.v1': 'sha256:cca03e9445364ca460edbe4cb97d3de612e39f694fc8440d891ed49d4721fa95',
		'products.v1.get': 'sha256:34c4d50ffab81f3ce51a30bba52c1af431759314a3f9ade739dc313b576faa65',
		spa: 'sha256:5accf6e8b1921c5fb3cb84af6dc8f7614ac5859232795f23cfa908b7655ae6f1',
	}

	test('every endpoint of the notes artifact, and the contract digest', () => {
		expect(Object.fromEntries(notesArtifact.endpoints.map((endpoint) => [endpoint.id, endpointDigest(notesArtifact, endpoint)]))).toEqual(RECORDED)
		// Recorded again when the artifact gained `format` (ADR-0062), and when a job's and a webhook's time limit became
		// `timeoutMs`. A 0.5 application keeps the digest its own release computes; Control's `formats.test.ts` holds that one.
		expect(contractDigest(notesArtifact)).toBe('sha256:a42e54f5fe0388ba60aabbbebc1ad9f8be595e81b65c914d6aea8b28f90e0bfa')
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

	test('covers the locale and the display name only when the artifact carries them', () => {
		const digest = contractDigest(notesArtifact)
		expect(contractDigest({ ...notesArtifact, locale: undefined, displayName: undefined })).toBe(digest)
		expect(contractDigest({ ...notesArtifact, locale: 'cs' })).not.toBe(digest)
		expect(contractDigest({ ...notesArtifact, displayName: 'Notes' })).not.toBe(digest)
		expect(contractDigest({ ...notesArtifact, displayName: 'Notes' })).not.toBe(contractDigest({ ...notesArtifact, displayName: 'Poznámky' }))
	})

	test('covers the e-mail templates only when the artifact carries them', () => {
		const digest = contractDigest(notesArtifact)
		const reset = { subject: 'Nové heslo', text: 'Heslo si nastavíte zde: {{actionUrl}}' }
		expect(contractDigest({ ...notesArtifact, mail: undefined })).toBe(digest)
		expect(contractDigest({ ...notesArtifact, mail: { reset: { cs: reset } } })).not.toBe(digest)
		expect(contractDigest({ ...notesArtifact, mail: { reset: { cs: reset } } })).not.toBe(
			contractDigest({ ...notesArtifact, mail: { reset: { cs: { ...reset, subject: 'Heslo' } } } }),
		)
	})

	test("covers a site's then and mailer only when it declares them", () => {
		const reach = { sql: 'write', unscoped: {}, connect: [], issues: null } as const
		const declaring = { ...notesArtifact, declared: { 'api.notes.create': reach, 'job:welcome': reach } }
		const digest = contractDigest(declaring)
		expect(
			contractDigest({ ...declaring, declared: { 'api.notes.create': { ...reach, then: undefined }, 'job:welcome': { ...reach, mailer: undefined } } }),
		)
			.toBe(digest)
		expect(contractDigest({ ...declaring, declared: { ...declaring.declared, 'api.notes.create': { ...reach, then: 'welcome' } } })).not.toBe(digest)
		expect(contractDigest({ ...declaring, declared: { ...declaring.declared, 'job:welcome': { ...reach, mailer: 'own' } } })).not.toBe(digest)
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

describe('installationTableDigest', () => {
	const health: InstallationAnonymousEndpoint = {
		id: 'health',
		kind: 'health',
		method: '*',
		path: '/healthz',
		callers: [],
		requirement: null,
		admission: null,
		oauth: null,
	}
	const console_: InstallationCredentialedEndpoint = {
		id: 'console',
		kind: 'service',
		method: 'GET',
		path: '/*',
		callers: ['human'],
		requirement: { kind: 'authenticated' },
		admission: null,
		oauth: null,
	}
	const table = { endpoints: [health, console_], reservedPrefixes: ['/api', '/mcp'] }

	test('row and prefix order carry no meaning', () => {
		expect(installationTableDigest({ endpoints: [console_, health], reservedPrefixes: ['/mcp', '/api'] })).toBe(installationTableDigest(table))
	})

	test("a row's rules, its id and the reserved prefixes each change it", () => {
		const digest = installationTableDigest(table)
		expect(installationTableDigest({ ...table, endpoints: [health, { ...console_, callers: ['human', 'machine'] }] })).not.toBe(digest)
		expect(installationTableDigest({ ...table, endpoints: [health, { ...console_, id: 'shell' }] })).not.toBe(digest)
		expect(installationTableDigest({ ...table, reservedPrefixes: ['/api'] })).not.toBe(digest)
	})
})
