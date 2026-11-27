// Each platform task's parameters over an in-memory Parameter Store: the names and values `installation-init` gives
// every cloud, each under its own task's path, the generated ones one value across their readers and never replaced,
// the bring-up's written once, the derived ones converged, the account's own S3 without a key, Control's AWS
// coordinates, and the names answered for the services' stack.

import type { InstallationSecrets } from '@fabrika/installation-init'
import { describe, expect, test } from 'bun:test'
import type { SsmPlatformSecrets } from '../../aws/ssm'
import { type AwsParametersInput, writeAwsParameters } from '../parameters'
import { checkAwsServicesInput } from '../services'
import { platformState } from './platform-fixture'

const PASSWORD = (service: string) => `${service.padEnd(8, 'x')}${'P'.repeat(32)}`

/** Parameter Store in memory, with the database's passwords the run wrote before the database. */
function fakeStore() {
	const store = new Map<string, string>()
	for (const service of ['iam', 'control', 'operations']) store.set(`/fabrika/platform/database/${service}-password`, PASSWORD(service))
	const replaced: string[] = []
	/** What another run writes at the same moment, just before this one's write of `name`. */
	const meanwhile = new Map<string, string>()
	const secrets: SsmPlatformSecrets = {
		putSecretOnce: async (name, value) => {
			const other = meanwhile.get(name)
			if (other !== undefined) store.set(name, other)
			if (store.has(name)) return false
			store.set(name, value)
			return true
		},
		putSecret: async (name, value) => {
			store.set(name, value)
			replaced.push(name)
		},
		readSecret: async (name) => store.get(name) ?? null,
		listNames: async (path) => [...store.keys()].filter((name) => name.startsWith(`${path}/`) && !name.slice(path.length + 1).includes('/')).sort(),
	}
	return { store, secrets, replaced, meanwhile }
}

const BRING_UP: AwsParametersInput['bringUp'] = { authentication: { passwordEnabled: true }, email: { kind: 'none' } }
const install = (secrets: SsmPlatformSecrets, lines: string[]): AwsParametersInput => ({ ...input(secrets, lines), bringUp: BRING_UP })

let generation = 0
/** A new set of secrets each call, so a value a run kept is told apart from one it made. */
function newSecrets(): InstallationSecrets {
	generation += 1
	const n = generation
	return {
		signingKeys: `[{"kty":"EC","n":${n}}]`,
		rpcKey: `px_rpc${n}`,
		proxyKey: `px_proxy${n}`,
		provisioningKey: `px_provisioning${n}`,
		operationsSyncKey: `sync${n}`,
		vaultKey: `vault${n}`,
		dataKey: `data${n}`,
	}
}

/** An upgrade's input: no bring-up values. An install adds `BRING_UP`. */
function input(secrets: SsmPlatformSecrets, lines: string[], overrides: Partial<AwsParametersInput> = {}): AwsParametersInput {
	return {
		state: platformState(),
		environment: 'production',
		manifest: { controlTableDigest: 'd'.repeat(64) },
		release: { repository: 'contember/fabrika-platform', commitSha: 'c'.repeat(40) },
		baseImage: `docker.io/oven/bun@sha256:${'e'.repeat(64)}`,
		secrets,
		signal: new AbortController().signal,
		log: (line) => lines.push(line),
		newSecrets,
		...overrides,
	}
}

describe("each platform task's parameters", () => {
	test('a fresh install writes every service its own values, the shared secrets one value across their readers', async () => {
		const { store, secrets } = fakeStore()
		const lines: string[] = []
		const names = await writeAwsParameters(install(secrets, lines))
		const at = (task: string, name: string) => store.get(`/fabrika/platform/${task}/${name}`)
		// One RPC key in IAM's, Control's and Operations' paths; the proxy key IAM checks is the one the proxies hold.
		expect(new Set([at('iam', 'FABRIKA_IAM_RPC_KEY'), at('control', 'FABRIKA_IAM_RPC_KEY'), at('operations', 'FABRIKA_IAM_RPC_KEY')]).size).toBe(1)
		expect(at('proxy', 'FABRIKA_IAM_KEY')).toBe(at('iam', 'FABRIKA_IAM_PROXY_KEY'))
		expect(at('control', 'FABRIKA_AWS_PROXY_IAM_KEY')).toBe(at('iam', 'FABRIKA_IAM_PROXY_KEY'))
		expect(at('control', 'OPERATIONS_SYNC_KEY')).toBe(at('operations', 'OPERATIONS_SYNC_KEY'))
		// Each service's database URL, as its own user, from its password under the database's path.
		expect(at('iam', 'FABRIKA_IAM_DATABASE_URL')).toBe(
			`postgres://fabrika_iam:${PASSWORD('iam')}@fabrika-database-abcdefgh.c1a2b3c4d5e6.eu-central-1.rds.amazonaws.com:5432/fabrika_iam?sslmode=require`,
		)
		// The account's own S3, signed with the task role: no key and no endpoint.
		expect(at('operations', 'FABRIKA_OPERATIONS_BLOB_BUCKET')).toBe('fabrika-operations-123456789012')
		expect(at('operations', 'FABRIKA_OPERATIONS_BLOB_CREDENTIALS')).toBe('container')
		expect(at('control', 'FABRIKA_CONTROL_RUN_LOGS_BUCKET')).toBe('fabrika-run-logs-123456789012')
		expect(at('control', 'FABRIKA_CONTROL_RUN_LOGS_REGION')).toBe('eu-central-1')
		for (const name of ['ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'ENDPOINT']) {
			expect(at('control', `FABRIKA_CONTROL_RUN_LOGS_${name}`)).toBeUndefined()
			expect(at('operations', `FABRIKA_OPERATIONS_BLOB_${name}`)).toBeUndefined()
		}
		// Control's AWS coordinates: the applications' cluster, network and listener, never the platform's.
		expect(at('control', 'FABRIKA_AWS_CLUSTER')).toBe('fabrika-apps')
		expect(at('control', 'FABRIKA_AWS_VPC_ID')).toBe('vpc-0123456789abcdef0')
		expect(at('control', 'FABRIKA_AWS_INSTALLATION_HOSTS')).toBe('iam.example.com,control.example.com,operations.example.com,apps.example.com')
		expect(at('control', 'FABRIKA_AWS_PROXY_REPOSITORY')).toBe('https://github.com/contember/fabrika-platform')
		expect(at('control', 'FABRIKA_AWS_PROXY_IAM_URL')).toBe('https://iam.example.com')
		// The proxy dials IAM at its Service Connect name; IAM issues under its public origin.
		expect(at('proxy', 'FABRIKA_PROXY_SESSION_OWNER_JSON')).toBe(JSON.stringify({ issuer: 'https://iam.example.com', upstream: 'iam:3000' }))
		expect(at('iam', 'ISSUER')).toBe('https://iam.example.com')
		expect(at('iam', 'FABRIKA_IAM_PASSWORD_ENABLED')).toBe('true')
		// The names answered are what each path holds, and the services' stack takes them.
		for (const task of ['iam', 'control', 'operations', 'proxy'] satisfies (keyof typeof names)[]) {
			expect([...names[task]].sort()).toEqual(
				[...store.keys()].filter((name) => name.startsWith(`/fabrika/platform/${task}/`)).map((name) => name.slice(`/fabrika/platform/${task}/`.length))
					.sort(),
			)
		}
		const state = platformState()
		expect(() =>
			checkAwsServicesInput({
				accountId: '123456789012',
				region: 'eu-central-1',
				platform: state.platform,
				runtime: state.runtime,
				database: state.database,
				balancers: state.balancers,
				images: { services: `sha256:${'a'.repeat(64)}`, proxy: `sha256:${'b'.repeat(64)}` },
				variables: names,
			})
		).not.toThrow()
		// Names only, never a value: no line holds any value the store holds (a short one like `true` aside).
		const logged = lines.join('\n')
		for (const value of store.values()) {
			if (value.length >= 8) expect(logged).not.toContain(value)
		}
	})

	test("an OIDC client and a mailer are the install's, written once and kept on an upgrade", async () => {
		const { store, secrets } = fakeStore()
		const lines: string[] = []
		await writeAwsParameters({
			...input(secrets, lines),
			bringUp: {
				authentication: { passwordEnabled: false, oidc: { issuer: 'https://login.example.com', clientId: 'fabrika', clientSecret: 'oidc-secret-value' } },
				email: {
					kind: 'provider',
					variables: new Map([['FABRIKA_EMAIL_PROVIDER', 'smtp'], ['FABRIKA_EMAIL_FROM', 'noreply@example.com']]),
					secretNames: new Set(),
				},
			},
		})
		const at = (task: string, name: string) => store.get(`/fabrika/platform/${task}/${name}`)
		expect([at('iam', 'FABRIKA_IAM_OIDC_ENABLED'), at('iam', 'FABRIKA_IAM_PASSWORD_ENABLED')]).toEqual(['true', 'false'])
		expect([at('iam', 'OIDC_ISSUER'), at('iam', 'OIDC_CLIENT_ID'), at('iam', 'OIDC_CLIENT_SECRET')]).toEqual([
			'https://login.example.com',
			'fabrika',
			'oidc-secret-value',
		])
		for (const task of ['iam', 'control']) expect(at(task, 'FABRIKA_EMAIL_FROM')).toBe('noreply@example.com')
		expect(at('operations', 'FABRIKA_EMAIL_FROM')).toBeUndefined()
		expect(lines.join('\n')).not.toContain('oidc-secret-value')
		// An operator rotates the client secret by hand; an upgrade, which names no bring-up, keeps it.
		store.set('/fabrika/platform/iam/OIDC_CLIENT_SECRET', 'rotated-by-hand')
		const names = await writeAwsParameters(input(secrets, []))
		expect(at('iam', 'OIDC_CLIENT_SECRET')).toBe('rotated-by-hand')
		expect(names.iam).toContain('OIDC_CLIENT_SECRET')
		expect(names.control).toContain('FABRIKA_EMAIL_FROM')
	})

	test("the proxy's secret for IAM is one value on both, and the manifest's OAuth reaches IAM and Operations", async () => {
		const { store, secrets } = fakeStore()
		await writeAwsParameters({
			...install(secrets, []),
			manifest: {
				controlTableDigest: 'd'.repeat(64),
				oauthConfig: { resources: [], hosts: ['iam.example.com', 'control.example.com', 'operations.example.com'] },
				operationsOAuthResource: 'https://operations.example.com/rpc',
			},
		})
		const at = (task: string, name: string) => store.get(`/fabrika/platform/${task}/${name}`)
		expect(at('iam', 'FABRIKA_INSTALLATION_PROXY_SECRET_IAM')).toBeDefined()
		expect(at('proxy', 'FABRIKA_INSTALLATION_PROXY_SECRET_IAM')).toBe(at('iam', 'FABRIKA_INSTALLATION_PROXY_SECRET_IAM'))
		expect(at('iam', 'FABRIKA_IAM_OAUTH_CONFIG')).toBe(
			JSON.stringify({ resources: [], hosts: ['iam.example.com', 'control.example.com', 'operations.example.com'] }),
		)
		expect(at('operations', 'FABRIKA_OPERATIONS_OAUTH_RESOURCE')).toBe('https://operations.example.com/rpc')
		expect(at('control', 'FABRIKA_SERVICE_TABLE_DIGEST')).toBe('d'.repeat(64))
	})

	test('an upgrade never makes a key the install made: a lost vault key is refused, IAM data key alone is added', async () => {
		const lost = fakeStore()
		await writeAwsParameters(install(lost.secrets, []))
		lost.store.delete('/fabrika/platform/control/FABRIKA_CONTROL_VAULT_KEY')
		const before = new Map(lost.store)
		await expect(writeAwsParameters(input(lost.secrets, []))).rejects.toThrow(
			"aws: the platform's vaultKey is in none of /fabrika/platform/control/FABRIKA_CONTROL_VAULT_KEY; an upgrade never makes a new one",
		)
		// Refused before any write.
		expect(lost.store).toEqual(before)
		for (const name of ['iam/FABRIKA_IAM_SIGNING_KEYS', 'iam/FABRIKA_IAM_PROVISIONING_KEY']) {
			const one = fakeStore()
			await writeAwsParameters(install(one.secrets, []))
			for (const task of ['iam', 'control']) one.store.delete(`/fabrika/platform/${task}/${name.split('/')[1]}`)
			await expect(writeAwsParameters(input(one.secrets, []))).rejects.toThrow('an upgrade never makes a new one')
		}
		// An installation made before IAM had a data key gets one.
		const older = fakeStore()
		await writeAwsParameters(install(older.secrets, []))
		older.store.delete('/fabrika/platform/iam/FABRIKA_IAM_DATA_KEY')
		await writeAwsParameters(input(older.secrets, []))
		expect(older.store.get('/fabrika/platform/iam/FABRIKA_IAM_DATA_KEY')).toBeDefined()
	})

	test('a shared key another run wrote meanwhile into one reader stops this run, naming the parameter', async () => {
		const { secrets, meanwhile } = fakeStore()
		meanwhile.set('/fabrika/platform/control/FABRIKA_IAM_PROVISIONING_KEY', 'px_the-other-run')
		const failure = await writeAwsParameters(install(secrets, [])).catch((error: unknown) => error)
		expect(String(failure)).toContain('aws: /fabrika/platform/control/FABRIKA_IAM_PROVISIONING_KEY holds another value than its readers settled on')
		expect(String(failure)).not.toContain('px_the-other-run')
	})

	test('an upgrade keeps every generated value and what an operator set by hand, and converges what it derives', async () => {
		const { store, secrets, replaced } = fakeStore()
		await writeAwsParameters(install(secrets, []))
		const before = new Map(store)
		// An operator turned password sign-in off by hand.
		store.set('/fabrika/platform/iam/FABRIKA_IAM_PASSWORD_ENABLED', 'false')
		replaced.length = 0
		const upgrade = input(secrets, [], { environment: 'prod' })
		await writeAwsParameters(upgrade)
		for (
			const name of ['iam/FABRIKA_IAM_SIGNING_KEYS', 'control/FABRIKA_CONTROL_VAULT_KEY', 'iam/FABRIKA_IAM_PROVISIONING_KEY', 'proxy/FABRIKA_IAM_KEY']
		) {
			expect(store.get(`/fabrika/platform/${name}`)).toBe(before.get(`/fabrika/platform/${name}`))
		}
		expect(store.get('/fabrika/platform/iam/FABRIKA_IAM_PASSWORD_ENABLED')).toBe('false')
		// Only what changed is written again: the environment's name, in each service's path.
		expect(replaced.sort()).toEqual(['control', 'iam', 'operations', 'proxy'].map((task) => `/fabrika/platform/${task}/ENVIRONMENT`))
		const third: string[] = []
		replaced.length = 0
		await writeAwsParameters({ ...upgrade, log: (line) => third.push(line) })
		expect(replaced).toEqual([])
		expect(third).toEqual(['iam', 'control', 'operations', 'proxy'].map((task) => `aws: the ${task} task's parameters are current`))
	})

	test('a run that stopped part way takes the shared value an earlier run wrote; two readers that differ are refused', async () => {
		const { store, secrets } = fakeStore()
		store.set('/fabrika/platform/iam/FABRIKA_IAM_RPC_KEY', 'px_earlier')
		await writeAwsParameters(install(secrets, []))
		expect(store.get('/fabrika/platform/control/FABRIKA_IAM_RPC_KEY')).toBe('px_earlier')
		expect(store.get('/fabrika/platform/operations/FABRIKA_IAM_RPC_KEY')).toBe('px_earlier')
		const split = fakeStore()
		split.store.set('/fabrika/platform/control/OPERATIONS_SYNC_KEY', 'sync-left')
		split.store.set('/fabrika/platform/operations/OPERATIONS_SYNC_KEY', 'sync-right')
		const failure = await writeAwsParameters(install(split.secrets, [])).catch((error: unknown) => error)
		expect(String(failure)).toContain("aws: the platform's operationsSyncKey differs between")
		expect(String(failure)).not.toContain('sync-left')
		expect(String(failure)).not.toContain('sync-right')
		// Nothing is written once a shared value is in doubt.
		expect([...split.store.keys()].filter((name) => !name.startsWith('/fabrika/platform/database/'))).toHaveLength(2)
	})

	test('a database password the run did not write first is refused by its name', async () => {
		const { store, secrets } = fakeStore()
		store.delete('/fabrika/platform/database/control-password')
		await expect(writeAwsParameters(install(secrets, []))).rejects.toThrow(
			'aws: the database password /fabrika/platform/database/control-password is missing',
		)
	})
})
