import { FABRIKA_SERVICE_TABLE_DIGEST, IAM_PROXY_SECRET_VARIABLE } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import type { InstallationEmail } from '../email'
import { generateInstallationSecrets } from '../secrets'
import {
	deployedServiceEnvironment,
	IAM_OAUTH_CONFIG_VARIABLE,
	INSTALLATION_SECRET_VARIABLES,
	installationServiceEnvironment,
	type InstallationServiceInput,
	type PlatformService,
} from '../service-environment'

const SERVICES: readonly PlatformService[] = ['iam', 'operations', 'control', 'proxy']

const storage = (name: string) => ({
	bucket: `${name}-bucket`,
	accessKeyId: `${name}-id`,
	secretAccessKey: `${name}-secret`,
	endpoint: `${name}-endpoint`,
})

const input = (overrides: Partial<InstallationServiceInput> = {}): InstallationServiceInput => ({
	environment: 'stage',
	scheme: 'https',
	hosts: { iam: 'iam.example.com', control: 'console.example.com', operations: 'errors.example.com' },
	iamUpstream: 'iam:3000',
	secrets: generateInstallationSecrets(),
	data: {
		iamDatabase: 'iam-dsn',
		controlDatabase: 'control-dsn',
		operationsDatabase: 'operations-dsn',
		runLogs: storage('runs'),
		operationsBlobs: storage('blobs'),
	},
	email: { kind: 'none' },
	...overrides,
})

describe('the bring-up environment', () => {
	test('a shared secret is the SAME value everywhere it is needed', () => {
		const { secrets } = input()
		const env = installationServiceEnvironment(input({ secrets }))
		expect(env.control.get('FABRIKA_IAM_RPC_KEY')).toBe(secrets.rpcKey)
		expect(env.operations.get('FABRIKA_IAM_RPC_KEY')).toBe(secrets.rpcKey)
		expect(env.iam.get('FABRIKA_IAM_RPC_KEY')).toBe(secrets.rpcKey)
		// IAM calls the proxy key `FABRIKA_IAM_PROXY_KEY`, the proxy `FABRIKA_IAM_KEY`.
		expect(env.proxy.get('FABRIKA_IAM_KEY')).toBe(env.iam.get('FABRIKA_IAM_PROXY_KEY'))
		expect(env.control.get('FABRIKA_IAM_PROVISIONING_KEY')).toBe(env.iam.get('FABRIKA_IAM_PROVISIONING_KEY'))
		expect(env.control.get('OPERATIONS_SYNC_KEY')).toBe(env.operations.get('OPERATIONS_SYNC_KEY'))
		expect(env.operations.has('FABRIKA_CONTROL_VAULT_KEY')).toBe(false)
	})

	test('`INSTALLATION_SECRET_VARIABLES` names exactly the variables whose value is generated', () => {
		const { secrets } = input()
		const env = installationServiceEnvironment(input({ secrets }))
		const generated = new Set<string>(Object.values(secrets))
		for (const service of SERVICES) {
			const carrying = [...env[service]].filter(([, value]) => generated.has(value)).map(([key]) => key)
			expect(carrying.sort()).toEqual([...INSTALLATION_SECRET_VARIABLES[service]].sort())
		}
	})

	test('the provider says where the data lives, and the public origins are derived from the hosts', () => {
		const env = installationServiceEnvironment(input())
		expect(env.iam.get('FABRIKA_IAM_DATABASE_URL')).toBe('iam-dsn')
		expect(env.control.get('FABRIKA_CONTROL_DATABASE_URL')).toBe('control-dsn')
		expect(env.operations.get('FABRIKA_OPERATIONS_DATABASE_URL')).toBe('operations-dsn')
		expect(env.control.get('FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY')).toBe('runs-secret')
		expect(env.operations.get('FABRIKA_OPERATIONS_BLOB_ENDPOINT')).toBe('blobs-endpoint')
		expect(env.iam.get('ISSUER')).toBe('https://iam.example.com')
		expect(env.control.get('FABRIKA_CONTROL_DOMAIN')).toBe('console.example.com')
		expect(env.control.get('OPERATIONS_ARTIFACT_ORIGIN')).toBe('https://errors.example.com')
		expect(env.proxy.get('FABRIKA_PROXY_SESSION_OWNER_JSON')).toBe(JSON.stringify({ issuer: 'https://iam.example.com', upstream: 'iam:3000' }))
	})

	test('the mail transport reaches IAM and control only', () => {
		const email: InstallationEmail = {
			kind: 'provider',
			variables: new Map([['FABRIKA_EMAIL_PROVIDER', 'resend'], ['FABRIKA_EMAIL_RESEND_API_KEY', 're_x']]),
			secretNames: new Set(['FABRIKA_EMAIL_RESEND_API_KEY']),
		}
		const env = installationServiceEnvironment(input({ email }))
		expect(env.iam.get('FABRIKA_EMAIL_RESEND_API_KEY')).toBe('re_x')
		expect(env.control.get('FABRIKA_EMAIL_PROVIDER')).toBe('resend')
		expect(env.operations.has('FABRIKA_EMAIL_PROVIDER')).toBe(false)
		expect(env.proxy.has('FABRIKA_EMAIL_PROVIDER')).toBe(false)
	})
})

describe('the deployed environment', () => {
	const deployed = (oauth: boolean) =>
		deployedServiceEnvironment({
			environment: 'stage',
			scheme: 'https',
			hosts: { iam: 'iam.example.com', control: 'console.example.com', operations: 'errors.example.com' },
			iamUpstream: 'iam:3000',
			provisioningKey: 'px_admin',
			controlTableDigest: 'digest',
			...(oauth ? { oauthConfig: { clients: [], resources: [] } } : {}),
		})

	test('the IAM proxy secret is an HMAC of the provisioning key, the same on IAM and the proxy', () => {
		const env = deployed(false)
		const expected = createHmac('sha256', 'px_admin').update('fabrika-installation-proxy-secret:iam').digest('hex')
		expect(env.iam.get(IAM_PROXY_SECRET_VARIABLE)).toBe(expected)
		expect(env.proxy.get(IAM_PROXY_SECRET_VARIABLE)).toBe(expected)
		expect(env.control.get(FABRIKA_SERVICE_TABLE_DIGEST)).toBe('digest')
	})

	test("IAM's OAuth configuration is written only when MCP authoring is on", () => {
		expect(deployed(false).iam.has(IAM_OAUTH_CONFIG_VARIABLE)).toBe(false)
		expect(deployed(true).iam.get(IAM_OAUTH_CONFIG_VARIABLE)).toBe(JSON.stringify({ clients: [], resources: [] }))
	})
})

/**
 * The names an existing installation already carries. A deploy writes by name, so a renamed one leaves the old variable
 * behind and the service reads none: change this list only with an upgrade step that converges an installation.
 */
describe('the variable names an installation carries', () => {
	const names = (env: ReadonlyMap<string, string>): string[] => [...env.keys()].sort()

	test('the bring-up writes exactly these names, without mail', () => {
		const env = installationServiceEnvironment(input())
		expect(names(env.iam)).toEqual([
			'ENVIRONMENT',
			'FABRIKA_IAM_DATABASE_URL',
			'FABRIKA_IAM_OIDC_ENABLED',
			'FABRIKA_IAM_PASSWORD_ENABLED',
			'FABRIKA_IAM_PROVISIONING_KEY',
			'FABRIKA_IAM_PROXY_KEY',
			'FABRIKA_IAM_RPC_KEY',
			'FABRIKA_IAM_SIGNING_KEYS',
			'ISSUER',
		])
		expect(names(env.operations)).toEqual([
			'ENVIRONMENT',
			'FABRIKA_IAM_ISSUER',
			'FABRIKA_IAM_RPC_KEY',
			'FABRIKA_OPERATIONS_BLOB_ACCESS_KEY_ID',
			'FABRIKA_OPERATIONS_BLOB_BUCKET',
			'FABRIKA_OPERATIONS_BLOB_ENDPOINT',
			'FABRIKA_OPERATIONS_BLOB_SECRET_ACCESS_KEY',
			'FABRIKA_OPERATIONS_DATABASE_URL',
			'FABRIKA_OPERATIONS_PUBLIC_HOST',
			'OPERATIONS_SYNC_KEY',
		])
		expect(names(env.control)).toEqual([
			'ENVIRONMENT',
			'FABRIKA_CONTROL_DATABASE_URL',
			'FABRIKA_CONTROL_DOMAIN',
			'FABRIKA_CONTROL_RUN_LOGS_ACCESS_KEY_ID',
			'FABRIKA_CONTROL_RUN_LOGS_BUCKET',
			'FABRIKA_CONTROL_RUN_LOGS_ENDPOINT',
			'FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY',
			'FABRIKA_CONTROL_VAULT_KEY',
			'FABRIKA_IAM_ISSUER',
			'FABRIKA_IAM_PROVISIONING_KEY',
			'FABRIKA_IAM_RPC_KEY',
			'OPERATIONS_ARTIFACT_ORIGIN',
			'OPERATIONS_SYNC_KEY',
		])
		expect(names(env.proxy)).toEqual(['ENVIRONMENT', 'FABRIKA_IAM_ISSUER', 'FABRIKA_IAM_KEY', 'FABRIKA_PROXY_SESSION_OWNER_JSON'])
	})

	test('a deploy writes exactly these names, and IAM the OAuth configuration only with MCP', () => {
		const deployed = (oauth: boolean) =>
			deployedServiceEnvironment({
				environment: 'stage',
				scheme: 'https',
				hosts: { iam: 'iam.example.com', control: 'console.example.com', operations: 'errors.example.com' },
				iamUpstream: 'iam:3000',
				provisioningKey: 'px_admin',
				controlTableDigest: 'digest',
				...(oauth ? { oauthConfig: { clients: [], resources: [] } } : {}),
			})
		const env = deployed(true)
		expect(names(env.iam)).toEqual(['ENVIRONMENT', IAM_OAUTH_CONFIG_VARIABLE, IAM_PROXY_SECRET_VARIABLE, 'ISSUER'])
		expect(names(deployed(false).iam)).toEqual(['ENVIRONMENT', IAM_PROXY_SECRET_VARIABLE, 'ISSUER'])
		expect(names(env.operations)).toEqual(['ENVIRONMENT', 'FABRIKA_IAM_ISSUER', 'FABRIKA_OPERATIONS_PUBLIC_HOST'])
		expect(names(env.control)).toEqual([
			'ENVIRONMENT',
			'FABRIKA_CONTROL_DOMAIN',
			'FABRIKA_IAM_ISSUER',
			FABRIKA_SERVICE_TABLE_DIGEST,
			'OPERATIONS_ARTIFACT_ORIGIN',
		])
		expect(names(env.proxy)).toEqual(['ENVIRONMENT', 'FABRIKA_IAM_ISSUER', IAM_PROXY_SECRET_VARIABLE, 'FABRIKA_PROXY_SESSION_OWNER_JSON'])
		// The two constants are the names an installation carries, not names of their own.
		expect([IAM_OAUTH_CONFIG_VARIABLE, IAM_PROXY_SECRET_VARIABLE, FABRIKA_SERVICE_TABLE_DIGEST]).toEqual([
			'FABRIKA_IAM_OAUTH_CONFIG',
			'FABRIKA_INSTALLATION_PROXY_SECRET_IAM',
			'FABRIKA_SERVICE_TABLE_DIGEST',
		])
	})
})
