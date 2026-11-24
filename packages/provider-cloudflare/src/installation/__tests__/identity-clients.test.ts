import type { SchemaReconcileInput } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { parseCloudflareIdentityClients, registerIdentityApps } from '../identity-clients'

// An external operations tool that signs people in through the installation's IAM.
const SONDA = {
	provider: 'external',
	clientId: 'https://sonda.contember.com/admin/oauth/client',
	redirectUris: ['https://sonda.contember.com/admin/oauth/callback'],
	identity: {
		app: 'sonda',
		resource: 'https://sonda.contember.com/admin',
		roles: [{ key: 'sonda-admin', name: 'Sonda administrator' }, { key: 'sonda-viewer', name: 'Sonda viewer' }],
	},
}
const HOSTS = ['console.example.com', 'iam.example.com', 'operations.example.com']
const IAM = { url: 'https://iam.example.com', adminKey: 'px_provisioning' }

describe('the client list of a Cloudflare installation', () => {
	test('accepts an identity-bound external client and reconciles its roles into IAM with the provisioning key', async () => {
		const clients = parseCloudflareIdentityClients(JSON.stringify([SONDA]), HOSTS)
		expect(clients).toEqual([{ ...SONDA, provider: 'external' }])
		const calls: SchemaReconcileInput[] = []
		await registerIdentityApps({ iam: IAM, clients, dryRun: false, reconcile: async (call) => void calls.push(call) })
		expect(calls).toEqual([{
			url: 'https://iam.example.com',
			app: 'sonda',
			schema: {
				scopes: [],
				actions: [],
				roles: {
					'sonda-admin': { name: 'Sonda administrator', permissions: [] },
					'sonda-viewer': { name: 'Sonda viewer', permissions: [] },
				},
			},
			adminKey: 'px_provisioning',
			signal: expect.any(AbortSignal),
		}])
	})

	test('an unset or empty variable registers no client and reconciles nothing', async () => {
		expect(parseCloudflareIdentityClients(undefined, HOSTS)).toEqual([])
		expect(parseCloudflareIdentityClients('', HOSTS)).toEqual([])
		await registerIdentityApps({ iam: undefined, clients: [], dryRun: false, reconcile: () => Promise.reject(new Error('called')) })
	})

	test('refuses an MCP client: the Worker console serves no /mcp', () => {
		const claude = {
			provider: 'claude',
			clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
			redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
		}
		expect(() => parseCloudflareIdentityClients(JSON.stringify([SONDA, claude]), HOSTS)).toThrow(
			'FABRIKA_PLATFORM_MCP_CLIENTS_JSON: client https://claude.ai/oauth/mcp-oauth-client-metadata is not an identity-bound external client',
		)
	})

	test('refuses an external client without an identity binding', () => {
		const { identity: _identity, ...unbound } = SONDA
		expect(() => parseCloudflareIdentityClients(JSON.stringify([unbound]), HOSTS)).toThrow('is not an identity-bound external client')
	})

	test("refuses an identity app that is a platform service's: its roles would rewrite that vocabulary", () => {
		for (const app of ['propustka', 'vozka', 'operations']) {
			const platform = { ...SONDA, identity: { ...SONDA.identity, app } }
			expect(() => parseCloudflareIdentityClients(JSON.stringify([platform]), HOSTS)).toThrow(`its identity app \`${app}\` is a platform service's`)
		}
	})

	test("refuses an identity resource on a platform service's host", () => {
		const onConsole = { ...SONDA, identity: { ...SONDA.identity, resource: 'https://console.example.com/sonda' } }
		expect(() => parseCloudflareIdentityClients(JSON.stringify([onConsole]), HOSTS)).toThrow("its identity resource is on a platform service's host")
	})

	test('refuses a malformed list, naming the variable', () => {
		expect(() => parseCloudflareIdentityClients('{', HOSTS)).toThrow('FABRIKA_PLATFORM_MCP_CLIENTS_JSON: the MCP client list is not valid JSON')
	})

	test('a dry run writes nothing; a real run without IAM refuses before writing', async () => {
		const clients = parseCloudflareIdentityClients(JSON.stringify([SONDA]), HOSTS)
		const reconcile = () => Promise.reject(new Error('called'))
		await registerIdentityApps({ iam: undefined, clients, dryRun: true, reconcile })
		await expect(registerIdentityApps({ iam: undefined, clients, dryRun: false, reconcile })).rejects.toThrow(
			'needs FABRIKA_IAM_ISSUER and FABRIKA_IAM_PROVISIONING_KEY',
		)
	})
})
