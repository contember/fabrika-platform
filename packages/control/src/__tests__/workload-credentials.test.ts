// The workload keys of an application environment (ADR-0022 "Principal kinds"): reconciled from the approved contract,
// one per job and webhook, sealed in the vault, rotated before IAM stops honouring them, and forgotten with the
// workload.

import { type ContractArtifact, MAX_KEY_LIFETIME_SECONDS, workloadKeyVariable } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { Vault } from '../vault'
import {
	type CredentialKind,
	declaredWorkloads,
	VaultWorkloadCredentials,
	WORKLOAD_KEY_ROTATE_BELOW_SECONDS,
	type WorkloadKeyIssuer,
} from '../workload-credentials'
import { createHarness, queryRows } from './helpers/harness'

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)))
/** The notes contract with its jobs and webhook, and no import. */
const workloadsOnly: ContractArtifact = { ...notesArtifact, imports: {} }
const T0 = 1_800_000_000

/**
 * IAM's issuance as `workloads.issueKey` does it: every key of the workload but `keep` and the new one is revoked. A
 * workload is its application and its kind and name, as IAM keys it.
 */
class RecordingIssuer implements WorkloadKeyIssuer {
	readonly issued: { app: string; kind: string; name: string; expiresAt: number; keep: string | null }[] = []
	readonly revoked: { app: string; kind: string; name: string }[] = []
	/** Live credential id → its workload. */
	readonly valid = new Map<string, string>()
	failRevoke = false

	issue(input: { app: string; kind: CredentialKind; name: string; expiresAt: number; keep: string | null }) {
		this.issued.push({ ...input })
		const workload = `${input.app}/${input.kind}:${input.name}`
		const credentialId = `${input.kind}:${input.name}:${this.issued.length}`
		for (const [id, of] of [...this.valid]) {
			if (of === workload && id !== input.keep) this.valid.delete(id)
		}
		this.valid.set(credentialId, workload)
		return Promise.resolve({ key: `px_${input.kind}_${input.name}_${this.issued.length}`, credentialId, expiresAt: input.expiresAt })
	}

	revoke(input: { app: string; kind: CredentialKind; name: string }) {
		if (this.failRevoke) return Promise.reject(new Error('IAM could not be asked'))
		this.revoked.push({ ...input })
		for (const [id, of] of [...this.valid]) {
			if (of === `${input.app}/${input.kind}:${input.name}`) this.valid.delete(id)
		}
		return Promise.resolve()
	}
}

async function setup() {
	const harness = createHarness()
	const { registry, workloadCredentials } = harness.repositories
	await registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
	await registry.upsertAppEnv({
		appId: 'notes',
		env: 'prod',
		namespaceId: null,
		provider: 'test',
		providerTargetJson: '{}',
		providerArtifactJson: '{}',
	})
	const vault = await Vault.create(harness.d1, KEY)
	const issuer = new RecordingIssuer()
	const clock = { now: T0 }
	const credentials = new VaultWorkloadCredentials(workloadCredentials, () => Promise.resolve(vault), issuer, () => clock.now)
	return { harness, issuer, clock, credentials }
}

describe('VaultWorkloadCredentials', () => {
	test('issues one key per job and webhook of the approved contract, for its <app>@<env>, at the longest lifetime', async () => {
		const { issuer, credentials } = await setup()
		expect((await credentials.reconcile('notes', 'prod', workloadsOnly)).variables).toEqual({
			FABRIKA_JOB_PURGE_DELETED_KEY: 'px_job_purgeDeleted_1',
			FABRIKA_WEBHOOK_GITHUB_KEY: 'px_webhook_github_2',
		})
		expect(issuer.issued).toEqual([
			{ app: 'notes@prod', kind: 'job', name: 'purgeDeleted', expiresAt: T0 + MAX_KEY_LIFETIME_SECONDS, keep: null },
			{ app: 'notes@prod', kind: 'webhook', name: 'github', expiresAt: T0 + MAX_KEY_LIFETIME_SECONDS, keep: null },
		])
	})

	test('answers the recorded key while it is fresh, and rotates it once less than half its lifetime is left', async () => {
		const { harness, issuer, clock, credentials } = await setup()
		const first = (await credentials.reconcile('notes', 'prod', workloadsOnly)).variables
		clock.now = T0 + MAX_KEY_LIFETIME_SECONDS - WORKLOAD_KEY_ROTATE_BELOW_SECONDS - 1
		expect((await credentials.reconcile('notes', 'prod', workloadsOnly)).variables).toEqual(first)
		expect(issuer.issued).toHaveLength(2)
		clock.now += 2
		const rotated = (await credentials.reconcile('notes', 'prod', workloadsOnly)).variables
		expect(rotated['FABRIKA_JOB_PURGE_DELETED_KEY']).toBe('px_job_purgeDeleted_3')
		expect(issuer.issued).toHaveLength(4)
		// The rotated keys replaced their vault rows: two rows, one per workload.
		expect(queryRows(harness.sqlite, 'SELECT label FROM vault ORDER BY label').map((row) => row['label'])).toEqual([
			'platform:workload-key:notes@prod:job:purgeDeleted',
			'platform:workload-key:notes@prod:webhook:github',
		])
	})

	test('a rotation whose record fails keeps the active key valid, and its retry revokes the orphan', async () => {
		const { harness, issuer, clock } = await setup()
		const vault = await Vault.create(harness.d1, KEY)
		const records = harness.repositories.workloadCredentials
		let failNextPut = false
		const flaky = new VaultWorkloadCredentials(
			{
				list: (appId, env) => records.list(appId, env),
				delete: (appId, env, kind, name) => records.delete(appId, env, kind, name),
				put: (row) => {
					if (failNextPut) {
						failNextPut = false
						return Promise.reject(new Error('the database went away'))
					}
					return records.put(row)
				},
			},
			() => Promise.resolve(vault),
			issuer,
			() => clock.now,
		)
		const first = (await flaky.reconcile('notes', 'prod', workloadsOnly)).variables
		const active = 'job:purgeDeleted:1'
		clock.now = T0 + MAX_KEY_LIFETIME_SECONDS
		failNextPut = true
		await expect(flaky.reconcile('notes', 'prod', workloadsOnly)).rejects.toThrow('the database went away')
		// B (job 3) was issued and not recorded; A is still the active key, and still valid.
		expect(issuer.valid.has(active)).toBe(true)
		expect(issuer.valid.has('job:purgeDeleted:3')).toBe(true)
		const retried = (await flaky.reconcile('notes', 'prod', workloadsOnly)).variables
		expect(issuer.issued.map((entry) => entry.keep)).toEqual([null, null, active, active, 'webhook:github:2'])
		expect(issuer.valid.has(active)).toBe(true)
		expect(issuer.valid.has('job:purgeDeleted:3')).toBe(false)
		expect(retried['FABRIKA_JOB_PURGE_DELETED_KEY']).not.toBe(first['FABRIKA_JOB_PURGE_DELETED_KEY'])
		// The failed attempt left no vault row behind: one per workload.
		expect(queryRows(harness.sqlite, 'SELECT label FROM vault')).toHaveLength(2)
	})

	test('stores only vault refs, and the vault only ciphertext', async () => {
		const { harness, credentials } = await setup()
		const keys = (await credentials.reconcile('notes', 'prod', workloadsOnly)).variables
		const stored = JSON.stringify([
			...queryRows(harness.sqlite, 'SELECT * FROM app_env_workload_credentials'),
			...queryRows(harness.sqlite, 'SELECT * FROM vault'),
		])
		for (const key of Object.values(keys)) {
			expect(stored).not.toContain(key)
		}
	})

	test('forgets the key of a workload the contract no longer declares, and needs none without a contract', async () => {
		const { harness, issuer, credentials } = await setup()
		await credentials.reconcile('notes', 'prod', workloadsOnly)
		const withoutJobs: ContractArtifact = { ...workloadsOnly, jobs: {} }
		expect(Object.keys((await credentials.reconcile('notes', 'prod', withoutJobs)).variables)).toEqual(['FABRIKA_WEBHOOK_GITHUB_KEY'])
		expect((await credentials.reconcile('notes', 'prod', null)).variables).toEqual({})
		expect(queryRows(harness.sqlite, 'SELECT * FROM app_env_workload_credentials')).toEqual([])
		expect(queryRows(harness.sqlite, 'SELECT * FROM vault')).toEqual([])
		expect(issuer.issued).toHaveLength(2)
	})
})

describe('VaultWorkloadCredentials, additive for a workspace sandbox', () => {
	test('drops no record, and rotates under the margin keeping the old keys valid for the sandboxes that hold them', async () => {
		const { harness, issuer, clock, credentials } = await setup()
		const first = await credentials.reconcile('notes', 'prod', workloadsOnly)
		expect(first.expiresAt).toBe(T0 + MAX_KEY_LIFETIME_SECONDS)
		clock.now = T0 + MAX_KEY_LIFETIME_SECONDS - WORKLOAD_KEY_ROTATE_BELOW_SECONDS - 1
		expect(await credentials.reconcile('notes', 'prod', workloadsOnly, { additive: true })).toEqual(first)
		expect(await credentials.reconcile('notes', 'prod', null, { additive: true })).toEqual({ variables: {}, expiresAt: null })
		expect(queryRows(harness.sqlite, 'SELECT name FROM app_env_workload_credentials')).toHaveLength(2)
		expect(issuer.issued).toHaveLength(2)
		expect(issuer.revoked).toEqual([])
		clock.now += 2
		const rotated = await credentials.reconcile('notes', 'prod', workloadsOnly, { additive: true })
		expect(rotated.variables).not.toEqual(first.variables)
		expect(rotated.expiresAt).toBe(clock.now + MAX_KEY_LIFETIME_SECONDS)
		expect(issuer.issued.slice(2).map((entry) => entry.keep)).toEqual(['job:purgeDeleted:1', 'webhook:github:2'])
		expect([...issuer.valid.keys()].sort()).toEqual(['job:purgeDeleted:1', 'job:purgeDeleted:3', 'webhook:github:2', 'webhook:github:4'])
	})
})

describe('VaultWorkloadCredentials for public procedures', () => {
	const reach = { sql: null, unscoped: {}, connect: [], issues: null }
	/** The notes contract with one public procedure, `api.stats.cta`, beside its jobs and webhook. */
	const withPublic: ContractArtifact = {
		...workloadsOnly,
		declared: { 'api.notes.list': reach, 'api.stats.cta': { ...reach, actions: ['notes.read'] } },
	}
	const cta = workloadKeyVariable('public', 'api.stats.cta')

	test('issues one key per public procedure, named by its endpoint id, under its own variable', async () => {
		const { issuer, credentials } = await setup()
		const keys = (await credentials.reconcile('notes', 'prod', withPublic)).variables
		expect(Object.keys(keys).sort()).toEqual(['FABRIKA_JOB_PURGE_DELETED_KEY', 'FABRIKA_WEBHOOK_GITHUB_KEY', cta].sort())
		expect(keys[cta]).toBe('px_public_api.stats.cta_3')
		expect(issuer.issued[2]).toEqual({ app: 'notes@prod', kind: 'public', name: 'api.stats.cta', expiresAt: T0 + MAX_KEY_LIFETIME_SECONDS, keep: null })
	})

	test('rotates the key like a job key, and forgets it once the contract no longer declares the procedure', async () => {
		const { harness, issuer, clock, credentials } = await setup()
		await credentials.reconcile('notes', 'prod', withPublic)
		clock.now = T0 + MAX_KEY_LIFETIME_SECONDS - WORKLOAD_KEY_ROTATE_BELOW_SECONDS + 1
		const rotated = (await credentials.reconcile('notes', 'prod', withPublic)).variables
		expect(rotated[cta]).toBe('px_public_api.stats.cta_6')
		expect(issuer.issued[5]?.keep).toBe('public:api.stats.cta:3')
		expect(Object.keys((await credentials.reconcile('notes', 'prod', workloadsOnly)).variables)).not.toContain(cta)
		expect(queryRows(harness.sqlite, "SELECT * FROM app_env_workload_credentials WHERE kind = 'public'")).toEqual([])
		expect(queryRows(harness.sqlite, 'SELECT label FROM vault ORDER BY label').map((row) => row['label'])).toEqual([
			'platform:workload-key:notes@prod:job:purgeDeleted',
			'platform:workload-key:notes@prod:webhook:github',
		])
	})
})

describe('VaultWorkloadCredentials for connectors', () => {
	const importing = (imports: ContractArtifact['imports']): ContractArtifact => ({ ...notesArtifact, jobs: {}, mounts: {}, imports })
	const catalog = notesArtifact.imports['catalog']
	if (catalog === undefined) throw new Error('the notes fixture imports the catalog')

	test('issues one app key per owner at <owner>@<env>, naming the consumer, under each import of that owner', async () => {
		const { harness, issuer, credentials } = await setup()
		const keys = (await credentials.reconcile(
			'notes',
			'prod',
			importing({ catalog, pricing: { ...catalog, export: 'prices' }, crm: { ...catalog, app: 'crm', export: 'contacts' } }),
		)).variables
		expect(keys).toEqual({
			FABRIKA_CONNECT_CATALOG_KEY: 'px_app_notes_1',
			FABRIKA_CONNECT_PRICING_KEY: 'px_app_notes_1',
			FABRIKA_CONNECT_CRM_KEY: 'px_app_notes_2',
		})
		expect(issuer.issued.map(({ app, kind, name, keep }) => ({ app, kind, name, keep }))).toEqual([
			{ app: 'catalog@prod', kind: 'app', name: 'notes', keep: null },
			{ app: 'crm@prod', kind: 'app', name: 'notes', keep: null },
		])
		expect(queryRows(harness.sqlite, 'SELECT kind, name FROM app_env_workload_credentials ORDER BY name')).toEqual([
			{ kind: 'app', name: 'catalog' },
			{ kind: 'app', name: 'crm' },
		])
		expect(queryRows(harness.sqlite, 'SELECT label FROM vault ORDER BY label').map((row) => row['label'])).toEqual([
			'platform:workload-key:notes@prod:app:catalog',
			'platform:workload-key:notes@prod:app:crm',
		])
	})

	test('keeps the recorded key while it is fresh, and revokes every key of an owner the contract no longer imports from', async () => {
		const { harness, issuer, clock, credentials } = await setup()
		const first = (await credentials.reconcile('notes', 'prod', importing({ catalog }))).variables
		expect((await credentials.reconcile('notes', 'prod', importing({ catalog }))).variables).toEqual(first)
		expect(issuer.issued).toHaveLength(1)
		// A rotation keeps the recorded key beside the new one; removing the import revokes both.
		clock.now = T0 + MAX_KEY_LIFETIME_SECONDS
		await credentials.reconcile('notes', 'prod', importing({ catalog }))
		expect(issuer.valid.size).toBe(2)
		expect((await credentials.reconcile('notes', 'prod', importing({}))).variables).toEqual({})
		expect(issuer.revoked).toEqual([{ app: 'catalog@prod', kind: 'app', name: 'notes' }])
		expect(issuer.valid.size).toBe(0)
		expect(queryRows(harness.sqlite, 'SELECT * FROM app_env_workload_credentials')).toEqual([])
		expect(queryRows(harness.sqlite, 'SELECT * FROM vault')).toEqual([])
	})

	test('a revocation IAM does not confirm fails the reconcile and keeps the record, so the retry revokes', async () => {
		const { harness, issuer, credentials } = await setup()
		await credentials.reconcile('notes', 'prod', importing({ catalog }))
		issuer.failRevoke = true
		await expect(credentials.reconcile('notes', 'prod', importing({}))).rejects.toThrow('IAM could not be asked')
		expect(queryRows(harness.sqlite, 'SELECT kind, name FROM app_env_workload_credentials')).toEqual([{ kind: 'app', name: 'catalog' }])
		expect(issuer.valid.size).toBe(1)
		issuer.failRevoke = false
		expect((await credentials.reconcile('notes', 'prod', importing({}))).variables).toEqual({})
		expect(issuer.valid.size).toBe(0)
		expect(queryRows(harness.sqlite, 'SELECT * FROM app_env_workload_credentials')).toEqual([])
	})
})

describe('declaredWorkloads', () => {
	test('refuses two workloads whose keys would travel under one variable', () => {
		const clashing: ContractArtifact = {
			...notesArtifact,
			jobs: { ...notesArtifact.jobs, purge_deleted: { schedule: '0 4 * * *', actions: [], scope: { kind: 'app' }, timeoutMs: 900000, retries: 0 } },
		}
		expect(() => declaredWorkloads(clashing)).toThrow('FABRIKA_JOB_PURGE_DELETED_KEY')
	})
})
