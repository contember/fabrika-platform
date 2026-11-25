import type { ImportOAuthClientsRequest, ImportOAuthClientsResponse } from '@fabrika/iam-contract'
import type { IamAdminConnection, OAuthClientImportApi } from '@fabrika/installation-init'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { assertCloudflareMcpAuthoringOff, importCloudflareOAuthClients, parseCloudflareIdentityClients } from '../identity-clients'

// An external operations tool that signs people in through the installation's IAM.
const OPS_TOOL = {
	provider: 'external',
	clientId: 'https://ops.example.org/admin/oauth/client',
	redirectUris: ['https://ops.example.org/admin/oauth/callback'],
	identity: {
		app: 'ops-tool',
		resource: 'https://ops.example.org/admin',
		roles: [{ key: 'ops-admin', name: 'Operations administrator' }, { key: 'ops-viewer', name: 'Operations viewer' }],
	},
}
const HOSTS = ['console.example.com', 'iam.example.com', 'operations.example.com']
const IAM = { url: 'https://iam.example.com', adminKey: 'px_provisioning' }

/** IAM's import as the stage reaches it, every call recorded. */
const fakeIam = (status: ImportOAuthClientsResponse['status']) => {
	const calls: { connection: IamAdminConnection; request: ImportOAuthClientsRequest }[] = []
	const connect = (connection: IamAdminConnection): OAuthClientImportApi => ({
		oauthClients: {
			importOnce: async (request) => {
				calls.push({ connection, request })
				return status === 'imported' ? { status, externalApps: ['ops-tool'], oauthClients: [OPS_TOOL.clientId] } : { status }
			},
		},
	})
	return { calls, connect }
}

describe('the client list of a Cloudflare installation', () => {
	test('accepts an identity-bound external client', () => {
		expect(parseCloudflareIdentityClients(JSON.stringify([OPS_TOOL]), HOSTS)).toEqual([{ ...OPS_TOOL, provider: 'external' }])
	})

	test('an unset or empty variable is absent', () => {
		expect(parseCloudflareIdentityClients(undefined, HOSTS)).toBeUndefined()
		expect(parseCloudflareIdentityClients('', HOSTS)).toBeUndefined()
	})

	test('refuses an MCP client as not supported on Cloudflare yet', () => {
		const claude = {
			provider: 'claude',
			clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
			redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
		}
		expect(() => parseCloudflareIdentityClients(JSON.stringify([OPS_TOOL, claude]), HOSTS)).toThrow(
			'FABRIKA_PLATFORM_MCP_CLIENTS_JSON: client https://claude.ai/oauth/mcp-oauth-client-metadata is not supported on Cloudflare yet',
		)
	})

	test('refuses an external client without an identity binding', () => {
		const { identity: _identity, ...unbound } = OPS_TOOL
		expect(() => parseCloudflareIdentityClients(JSON.stringify([unbound]), HOSTS)).toThrow('is not supported on Cloudflare yet')
	})

	test("refuses an identity app that is a platform service's", () => {
		for (const app of ['propustka', 'vozka', 'operations']) {
			const platform = { ...OPS_TOOL, identity: { ...OPS_TOOL.identity, app } }
			expect(() => parseCloudflareIdentityClients(JSON.stringify([platform]), HOSTS)).toThrow(`its identity app \`${app}\` is a platform service's`)
		}
	})

	test("refuses an identity resource on a platform service's host", () => {
		const onConsole = { ...OPS_TOOL, identity: { ...OPS_TOOL.identity, resource: 'https://console.example.com/ops' } }
		expect(() => parseCloudflareIdentityClients(JSON.stringify([onConsole]), HOSTS)).toThrow("its identity resource is on a platform service's host")
	})

	test('refuses a malformed list, naming the variable', () => {
		expect(() => parseCloudflareIdentityClients('{', HOSTS)).toThrow('FABRIKA_PLATFORM_MCP_CLIENTS_JSON: the MCP client list is not valid JSON')
	})
})

describe('the MCP authoring switch on Cloudflare', () => {
	test('unset or off passes; on is refused as not supported yet; anything else is refused as malformed', () => {
		assertCloudflareMcpAuthoringOff({})
		assertCloudflareMcpAuthoringOff({ FABRIKA_PLATFORM_MCP_AUTHORING: 'off' })
		assertCloudflareMcpAuthoringOff({ FABRIKA_PLATFORM_MCP_AUTHORING: ' ' })
		expect(() => assertCloudflareMcpAuthoringOff({ FABRIKA_PLATFORM_MCP_AUTHORING: 'on' })).toThrow(
			'FABRIKA_PLATFORM_MCP_AUTHORING=on: a Cloudflare installation does not support MCP authoring yet',
		)
		expect(() => assertCloudflareMcpAuthoringOff({ FABRIKA_PLATFORM_MCP_AUTHORING: 'yes' })).toThrow('must be on or off')
	})
})

describe("the control-plane stage's import of the client list into IAM", () => {
	let output: string[]
	const spies: { mockRestore(): void }[] = []
	beforeEach(() => {
		output = []
		spies.push(spyOn(console, 'info').mockImplementation((line: string) => void output.push(`info: ${line}`)))
		spies.push(spyOn(console, 'warn').mockImplementation((line: string) => void output.push(`warn: ${line}`)))
	})
	afterEach(() => {
		for (const spy of spies.splice(0)) spy.mockRestore()
	})

	test("imports the variable's entries with the provisioning key, at IAM's issuer", async () => {
		const iam = fakeIam('imported')
		const clients = parseCloudflareIdentityClients(JSON.stringify([OPS_TOOL]), HOSTS)
		await importCloudflareOAuthClients({ iam: IAM, clients, dryRun: false, connect: iam.connect })
		expect(iam.calls).toEqual([{ connection: { origin: IAM.url, provisioningKey: IAM.adminKey }, request: { clients: [OPS_TOOL] } }])
		expect(output[0]).toBe(
			'info: IAM imported the OAuth client list: 1 external application(s) (ops-tool), 1 client(s); it serves its registry from now on',
		)
		// The importing stage warns too: every deploy does while the variable is set.
		expect(output[1]).toStartWith('warn: FABRIKA_PLATFORM_MCP_CLIENTS_JSON imported; this release no longer reads the variable')
		expect(output).toHaveLength(2)
	})

	test('an unset variable still imports, with no entries', async () => {
		const iam = fakeIam('imported')
		await importCloudflareOAuthClients({ iam: IAM, clients: undefined, dryRun: false, connect: iam.connect })
		expect(iam.calls.map((call) => call.request)).toEqual([{ clients: [] }])
		expect(output.some((line) => line.startsWith('warn:'))).toBe(false)
	})

	test('already imported while the variable is set: warns to delete it', async () => {
		const iam = fakeIam('already_imported')
		await importCloudflareOAuthClients({ iam: IAM, clients: [], dryRun: false, connect: iam.connect })
		expect(output.some((line) => line.startsWith('warn: FABRIKA_PLATFORM_MCP_CLIENTS_JSON this release no longer reads the variable'))).toBe(true)
	})

	test('a dry run calls nothing; a real run without IAM refuses before calling', async () => {
		const iam = fakeIam('imported')
		await importCloudflareOAuthClients({ iam: undefined, clients: undefined, dryRun: true, connect: iam.connect })
		await expect(importCloudflareOAuthClients({ iam: undefined, clients: undefined, dryRun: false, connect: iam.connect })).rejects.toThrow(
			'needs FABRIKA_IAM_ISSUER and FABRIKA_IAM_PROVISIONING_KEY',
		)
		expect(iam.calls).toEqual([])
	})

	test("IAM's refusal fails the stage", async () => {
		const connect = (): OAuthClientImportApi => ({ oauthClients: { importOnce: () => Promise.reject(new Error('refused')) } })
		await expect(importCloudflareOAuthClients({ iam: IAM, clients: undefined, dryRun: false, connect })).rejects.toThrow(
			'oauthClients.importOnce failed: refused',
		)
	})
})
