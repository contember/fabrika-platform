import { RpcError } from '@fabrika/app'
import { type ExternalAppDto, OAUTH_REGISTRY_NOT_IMPORTED } from '@fabrika/iam-contract'
import { describe, expect, test } from 'bun:test'
import { auditActionLabel } from '../access/lib/audit-labels'
import { draftConsequences, draftOf, emptyDraft, type ExternalAppDraft, externalAppRequest, registryNotImported } from '../access/lib/external-apps'

const WEB_CLIENT = 'https://ops.example.com/oauth/client.json'

const STORED: ExternalAppDto = {
	app: 'ops-tool',
	name: 'Ops tool',
	resource: 'https://ops.example.com',
	roles: [{ key: 'viewer', name: 'Viewer' }, { key: 'editor', name: 'Editor' }],
	clients: [
		{ clientId: WEB_CLIENT, redirectUris: ['https://ops.example.com/cb'], metadataUrl: null },
		{ clientId: 'https://ops.example.com/oauth/cli.json', redirectUris: ['http://localhost:8765/cb'], metadataUrl: 'https://cdn.example.com/cli.json' },
	],
	createdAt: 1,
	updatedAt: 2,
}

function draft(patch: Partial<ExternalAppDraft>): ExternalAppDraft {
	return { ...draftOf(STORED), ...patch }
}

describe('the external application form', () => {
	test('a stored application round-trips into the request that replaces it unchanged', () => {
		expect(externalAppRequest(draftOf(STORED))).toEqual({
			ok: true,
			request: {
				app: 'ops-tool',
				name: 'Ops tool',
				resource: 'https://ops.example.com',
				roles: [{ key: 'viewer', name: 'Viewer' }, { key: 'editor', name: 'Editor' }],
				clients: [
					{ clientId: WEB_CLIENT, redirectUris: ['https://ops.example.com/cb'], metadataUrl: null },
					{
						clientId: 'https://ops.example.com/oauth/cli.json',
						redirectUris: ['http://localhost:8765/cb'],
						metadataUrl: 'https://cdn.example.com/cli.json',
					},
				],
			},
		})
	})

	test('no roles is sent as null, so every active user signs in; redirect URIs are one per line, blank lines dropped', () => {
		const checked = externalAppRequest(
			draft({
				roles: [],
				clients: [{ clientId: WEB_CLIENT, redirectUris: ' https://a.example/cb \n\nhttps://b.example/cb\n', metadataUrl: ' ' }],
			}),
		)
		expect(checked.ok && checked.request.roles).toBeNull()
		expect(checked.ok && checked.request.clients).toEqual([{
			clientId: WEB_CLIENT,
			redirectUris: ['https://a.example/cb', 'https://b.example/cb'],
			metadataUrl: null,
		}])
	})

	test('each refusal IAM would answer is named at its field', () => {
		const checked = externalAppRequest({
			app: 'Ops@Tool',
			name: ' padded',
			resource: 'http://ops.example.com',
			roles: [{ key: 'admin', name: 'Admin' }, { key: 'viewer', name: '' }, { key: 'viewer', name: 'Again' }],
			clients: [
				{ clientId: 'https://ops.example.com', redirectUris: '', metadataUrl: 'http://ops.example.com/doc' },
				{ clientId: 'https://ops.example.com/c.json', redirectUris: 'https://x.example/cb#frag', metadataUrl: '' },
				{ clientId: 'https://ops.example.com/c.json', redirectUris: 'https://x.example/cb\nhttps://x.example/cb', metadataUrl: '' },
			],
		})
		expect(checked.ok).toBe(false)
		expect(checked.ok ? [] : [...checked.problems.keys()].sort()).toEqual([
			'app',
			'clients.0.clientId',
			'clients.0.metadataUrl',
			'clients.0.redirectUris',
			'clients.1.redirectUris',
			'clients.2.clientId',
			'clients.2.redirectUris',
			'name',
			'resource',
			'roles.0.key',
			'roles.1.name',
			'roles.2.key',
		])
	})

	test('a new application starts with one empty client and no roles', () => {
		expect(emptyDraft()).toEqual({ app: '', name: '', resource: '', roles: [], clients: [{ clientId: '', redirectUris: '', metadataUrl: '' }] })
	})
})

describe('what a save would change', () => {
	const none = { rolesIntroduced: false, rolesDropped: false, removedRoles: [], removedClients: [], resourceChanged: false }

	test('an unchanged application warns of nothing', () => {
		expect(draftConsequences(STORED, draftOf(STORED))).toEqual(none)
	})

	test('roles added to an application that had none refuse everyone until granted; a new one with roles too', () => {
		const roleless = { ...STORED, roles: null }
		expect(draftConsequences(roleless, draft({})).rolesIntroduced).toBe(true)
		expect(draftConsequences(null, { ...emptyDraft(), roles: [{ key: 'viewer', name: 'Viewer' }] }).rolesIntroduced).toBe(true)
		expect(draftConsequences(null, emptyDraft())).toEqual(none)
	})

	test('a removed role, all roles dropped, a removed client and a new resource are each named', () => {
		expect(draftConsequences(STORED, draft({ roles: [{ key: 'viewer', name: 'Viewer' }] })).removedRoles).toEqual(['editor'])
		expect(draftConsequences(STORED, draft({ roles: [] }))).toMatchObject({ rolesDropped: true, removedRoles: [] })
		expect(draftConsequences(STORED, draft({ clients: draftOf(STORED).clients.slice(1) })).removedClients).toEqual([WEB_CLIENT])
		expect(draftConsequences(STORED, draft({ resource: 'https://new.example.com' })).resourceChanged).toBe(true)
	})
})

describe('IAM before the deploy imported its client list', () => {
	test("is told apart from any other conflict by IAM's own refusal", () => {
		expect(registryNotImported(new RpcError({ type: 'conflict', message: OAUTH_REGISTRY_NOT_IMPORTED, httpStatus: 409 }))).toBe(true)
		expect(registryNotImported(new RpcError({ type: 'conflict', message: 'the resource is taken', httpStatus: 409 }))).toBe(false)
		expect(registryNotImported(new Error(OAUTH_REGISTRY_NOT_IMPORTED))).toBe(false)
	})
})

describe('the audit labels of the client registry', () => {
	test('name the registry actions and why sign-ins were revoked', () => {
		expect(auditActionLabel('iam.external_app.put')).toBe('External application saved')
		expect(auditActionLabel('iam.oauth_registry.import')).toBe('OAuth client list imported')
		expect(auditActionLabel('iam.oauth.grant.revoke', { reason: 'application_removed' })).toBe('Sign-ins revoked: application deleted')
		expect(auditActionLabel('iam.oauth.grant.revoke', { reason: 'administrator' })).toBe('Connected client disconnected')
		expect(auditActionLabel('iam.oauth.grant.revoke', null)).toBe('Connected client disconnected')
	})
})
