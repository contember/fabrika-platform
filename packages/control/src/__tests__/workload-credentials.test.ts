// The workload keys of an application environment (ADR-0022 "Principal kinds"): reconciled from the approved contract,
// one per job and webhook, sealed in the vault, rotated before IAM stops honouring them, and forgotten with the
// workload.

import { type ContractArtifact, MAX_KEY_LIFETIME_SECONDS } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { Vault } from '../vault'
import { declaredWorkloads, VaultWorkloadCredentials, WORKLOAD_KEY_ROTATE_BELOW_SECONDS, type WorkloadKeyIssuer } from '../workload-credentials'
import { createHarness, queryRows } from './helpers/harness'

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)))
const T0 = 1_800_000_000

/** IAM's issuance as `workloads.issueKey` does it: every key of the workload but `keep` and the new one is revoked. */
class RecordingIssuer implements WorkloadKeyIssuer {
	readonly issued: { app: string; kind: string; name: string; expiresAt: number; keep: string | null }[] = []
	readonly valid = new Set<string>()

	issue(input: { app: string; kind: 'job' | 'webhook'; name: string; expiresAt: number; keep: string | null }) {
		this.issued.push({ ...input })
		const credentialId = `${input.kind}:${input.name}:${this.issued.length}`
		for (const id of [...this.valid]) {
			if (id.startsWith(`${input.kind}:${input.name}:`) && id !== input.keep) this.valid.delete(id)
		}
		this.valid.add(credentialId)
		return Promise.resolve({ key: `px_${input.kind}_${input.name}_${this.issued.length}`, credentialId, expiresAt: input.expiresAt })
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
		expect(await credentials.reconcile('notes', 'prod', notesArtifact)).toEqual({
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
		const first = await credentials.reconcile('notes', 'prod', notesArtifact)
		clock.now = T0 + MAX_KEY_LIFETIME_SECONDS - WORKLOAD_KEY_ROTATE_BELOW_SECONDS - 1
		expect(await credentials.reconcile('notes', 'prod', notesArtifact)).toEqual(first)
		expect(issuer.issued).toHaveLength(2)
		clock.now += 2
		const rotated = await credentials.reconcile('notes', 'prod', notesArtifact)
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
		const first = await flaky.reconcile('notes', 'prod', notesArtifact)
		const active = 'job:purgeDeleted:1'
		clock.now = T0 + MAX_KEY_LIFETIME_SECONDS
		failNextPut = true
		await expect(flaky.reconcile('notes', 'prod', notesArtifact)).rejects.toThrow('the database went away')
		// B (job 3) was issued and not recorded; A is still the active key, and still valid.
		expect(issuer.valid.has(active)).toBe(true)
		expect(issuer.valid.has('job:purgeDeleted:3')).toBe(true)
		const retried = await flaky.reconcile('notes', 'prod', notesArtifact)
		expect(issuer.issued.map((entry) => entry.keep)).toEqual([null, null, active, active, 'webhook:github:2'])
		expect(issuer.valid.has(active)).toBe(true)
		expect(issuer.valid.has('job:purgeDeleted:3')).toBe(false)
		expect(retried['FABRIKA_JOB_PURGE_DELETED_KEY']).not.toBe(first['FABRIKA_JOB_PURGE_DELETED_KEY'])
		// The failed attempt left no vault row behind: one per workload.
		expect(queryRows(harness.sqlite, 'SELECT label FROM vault')).toHaveLength(2)
	})

	test('stores only vault refs, and the vault only ciphertext', async () => {
		const { harness, credentials } = await setup()
		const keys = await credentials.reconcile('notes', 'prod', notesArtifact)
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
		await credentials.reconcile('notes', 'prod', notesArtifact)
		const withoutJobs: ContractArtifact = { ...notesArtifact, jobs: {} }
		expect(Object.keys(await credentials.reconcile('notes', 'prod', withoutJobs))).toEqual(['FABRIKA_WEBHOOK_GITHUB_KEY'])
		expect(await credentials.reconcile('notes', 'prod', null)).toEqual({})
		expect(queryRows(harness.sqlite, 'SELECT * FROM app_env_workload_credentials')).toEqual([])
		expect(queryRows(harness.sqlite, 'SELECT * FROM vault')).toEqual([])
		expect(issuer.issued).toHaveLength(2)
	})
})

describe('declaredWorkloads', () => {
	test('refuses two workloads whose keys would travel under one variable', () => {
		const clashing: ContractArtifact = {
			...notesArtifact,
			jobs: { ...notesArtifact.jobs, purge_deleted: { schedule: '0 4 * * *', actions: [], scope: { kind: 'app' }, timeout: null, retries: 0 } },
		}
		expect(() => declaredWorkloads(clashing)).toThrow('FABRIKA_JOB_PURGE_DELETED_KEY')
	})
})
