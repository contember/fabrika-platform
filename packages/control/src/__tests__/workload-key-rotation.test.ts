// The maintenance pass renews an environment's workload keys before they expire and hands them to the version it runs
// without a deploy (`rotateWorkloadKeys`): a key near expiry is re-issued with the replaced one kept valid, written
// through the provider, and its job is authorised by IAM afterwards; a failed write keeps the key pending and the next
// pass writes it again; a key a succeeded deploy handed is confirmed without a write.

import { schemaFromContract } from '@fabrika/app/contract'
import { type ContractArtifact, MAX_KEY_LIFETIME_SECONDS, WORKLOAD_TOKEN_PATH } from '@fabrika/auth-core'
import { SqlDeployLocks, uuidv7 } from '@fabrika/platform'
import { unusedDatabase } from '@fabrika/platform/testing'
import type { ControlProvider, ProviderManagedCredentialsInput } from '@fabrika/provider-contract'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { createHarness as createIamHarness, type Harness as IamHarness, TEST_SIGNING_KEYS } from '../../../iam/src/__tests__/helpers/harness'
import { createIamApp } from '../../../iam/src/app'
import { prop } from '../../../iam/src/json'
import { acquireLease, runLeaseKey } from '../lease'
import { Vault } from '../vault'
import { type CredentialKind, iamWorkloadKeyIssuer, VaultWorkloadCredentials, type WorkloadKeyIssuer } from '../workload-credentials'
import { rotateWorkloadKeys, rotatingProvider, type WorkloadKeyRotationDeps } from '../workload-key-rotation'
import { createHarness, queryRows } from './helpers/harness'

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
const IAM_ORIGIN = 'https://iam.rotation.test'
const PROVISIONING_KEY = `px_${'r'.repeat(43)}`
const DAY = 24 * 60 * 60
/** The notes contract with its job `purgeDeleted` and its webhook `github`, and no import. */
const contract: ContractArtifact = { ...notesArtifact, imports: {} }
const JOB_VARIABLE = 'FABRIKA_JOB_PURGE_DELETED_KEY'
const WEBHOOK_VARIABLE = 'FABRIKA_WEBHOOK_GITHUB_KEY'

/** The provider's write, as the version the environment runs would hold it; `failures` writes refuse first. */
class RunningVersion {
	readonly writes: Record<string, string>[] = []
	readonly held: Record<string, string> = {}
	failures = 0

	readonly provider: ControlProvider = {
		id: 'test',
		deploy: () => Promise.resolve({ state: 'succeeded' }),
		managedCredentials: {
			write: (input: ProviderManagedCredentialsInput) => {
				if (this.failures > 0) {
					this.failures--
					return Promise.reject(new Error('the provider refused the write'))
				}
				this.writes.push({ ...input.values })
				Object.assign(this.held, input.values)
				return Promise.resolve()
			},
		},
	}
}

/** `workloads.issueKey` as IAM answers it: every key of the workload but `keep` and the new one is revoked. */
class RecordingIssuer implements WorkloadKeyIssuer {
	readonly issued: { kind: string; name: string; keep: string | null }[] = []
	readonly valid = new Map<string, string>()
	/** Runs inside IAM's issuance: what another writer does meanwhile. */
	meanwhile: (() => Promise<void>) | null = null

	async issue(input: { app: string; kind: CredentialKind; name: string; expiresAt: number; keep: string | null }) {
		await this.meanwhile?.()
		this.issued.push({ kind: input.kind, name: input.name, keep: input.keep })
		const workload = `${input.app}/${input.kind}:${input.name}`
		const key = `px_${input.kind}_${input.name}_${this.issued.length}`
		for (const [held, of] of [...this.valid]) {
			if (of === workload && held !== input.keep) this.valid.delete(held)
		}
		this.valid.set(key, workload)
		return { key, credentialId: key, expiresAt: input.expiresAt }
	}

	revoke() {
		return Promise.resolve()
	}
}

async function world(issuer: WorkloadKeyIssuer, clock: { now: number }) {
	const harness = createHarness(() => clock.now)
	const { registry } = harness.repositories
	await registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
	await registry.upsertAppEnv({
		appId: 'notes',
		env: 'prod',
		namespaceId: null,
		provider: 'test',
		providerTargetJson: JSON.stringify({ provider: 'test', version: 1, payload: {} }),
		providerArtifactJson: JSON.stringify({ provider: 'test', version: 1, payload: {} }),
	})
	await harness.d1.prepare('UPDATE app_envs SET published_run_id = ?, published_snapshot_json = ? WHERE app_id = ? AND env = ?').bind(
		'01920000-0000-7000-8000-0000000000aa',
		JSON.stringify({ version: 1, contract, migrations: [], checker: '0.9.0' }),
		'notes',
		'prod',
	).run()
	const vault = await Vault.create(harness.d1, KEY)
	const credentials = new VaultWorkloadCredentials(harness.repositories.workloadCredentials, () => Promise.resolve(vault), issuer, () => clock.now)
	const running = new RunningVersion()
	const locks = new SqlDeployLocks(harness.d1)
	const provider = rotatingProvider(running.provider)
	if (provider === null) throw new Error('the fake provider writes managed credentials')
	const deps: WorkloadKeyRotationDeps = { repositories: harness.repositories, credentials, provider, locks, now: () => clock.now }
	/** A deploy's reconcile, and its success: the running version holds what it handed. */
	const deploy = async () => {
		const handed = await credentials.reconcile('notes', 'prod', contract)
		Object.assign(running.held, handed.variables)
		await harness.d1.prepare('UPDATE app_env_workload_credentials SET pending = 0').run()
		return handed.variables
	}
	const records = () =>
		queryRows(harness.sqlite, 'SELECT kind, name, pending, handed_by, held_expires_at, expires_at FROM app_env_workload_credentials ORDER BY kind')
	return { harness, credentials, running, locks, deps, deploy, records }
}

describe('the maintenance pass renews workload keys without a deploy, against IAM', () => {
	let iam: IamHarness | null = null
	afterEach(() => {
		iam?.sqlite.close()
		iam = null
	})

	function iamFetch(h: IamHarness, request: Request): Promise<Response> {
		return createIamApp().fetch(request, {
			DB: unusedDatabase,
			REPOSITORIES: h.repositories,
			HUMAN_EMAIL_DOMAINS: '[]',
			HUMAN_EMAILS: '[]',
			IAM_BOOTSTRAP_ADMINS: '[]',
			ENVIRONMENT: 'stage',
			ISSUER: IAM_ORIGIN,
			FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
			FABRIKA_IAM_PROVISIONING_KEY: PROVISIONING_KEY,
			OIDC_ISSUER: 'https://idp.test',
			OIDC_CLIENT_ID: 'client',
			OIDC_CLIENT_SECRET: 'secret',
			OIDC_SCOPES: '',
			OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
		}, { waitUntil() {} })
	}

	/** What IAM's public workload token exchange answers a key: the job's token claims, or its refusal. */
	async function exchange(h: IamHarness, key: string): Promise<{ ok: boolean; reason?: unknown }> {
		const response = await iamFetch(
			h,
			new Request(`${IAM_ORIGIN}${WORKLOAD_TOKEN_PATH}`, {
				method: 'POST',
				headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
				body: JSON.stringify({ app: 'notes@prod' }),
			}),
		)
		const body: unknown = await response.json()
		return prop(body, 'ok') === true ? { ok: true } : { ok: false, reason: prop(body, 'reason') }
	}

	test('a key near expiry is re-issued, written to the running version, and its job is authorised; the replaced key works on meanwhile', async () => {
		const h = createIamHarness()
		iam = h
		const schema = await iamFetch(
			h,
			new Request(`${IAM_ORIGIN}/admin/apps/${encodeURIComponent('notes@prod')}/schema`, {
				method: 'PUT',
				headers: { authorization: `Bearer ${PROVISIONING_KEY}`, 'content-type': 'application/json' },
				body: JSON.stringify(schemaFromContract(contract)),
			}),
		)
		expect(schema.status).toBe(200)
		const issuer = iamWorkloadKeyIssuer({
			origin: IAM_ORIGIN,
			provisioningKey: PROVISIONING_KEY,
			fetch: (input, init) => iamFetch(h, new Request(input, init)),
		})
		const realNow = Math.floor(Date.now() / 1000)
		// The last deploy ran 20 days ago: its keys have 10 days left, below the rotate threshold of 15.
		const clock = { now: realNow - 20 * DAY }
		const w = await world(issuer, clock)
		const deployed = await w.deploy()
		const old = deployed[JOB_VARIABLE]
		if (old === undefined) throw new Error('the deploy handed the job a key')
		expect(await exchange(h, old)).toEqual({ ok: true })

		clock.now = realNow
		expect(await rotateWorkloadKeys(w.deps)).toEqual({ written: 2, confirmed: 0, busy: 0, failed: 0 })
		expect(w.running.writes).toHaveLength(1)
		const renewed = w.running.held[JOB_VARIABLE]
		if (renewed === undefined) throw new Error('the pass wrote the job key')
		expect(renewed).not.toBe(old)
		expect(Object.keys(w.running.writes[0] ?? {}).sort()).toEqual([JOB_VARIABLE, WEBHOOK_VARIABLE])
		// The job is authorised with the key the running version now holds, and the replaced one still works until it expires.
		expect(await exchange(h, renewed)).toEqual({ ok: true })
		expect(await exchange(h, old)).toEqual({ ok: true })
		expect(w.records()).toEqual([
			{ kind: 'job', name: 'purgeDeleted', pending: 0, handed_by: null, held_expires_at: null, expires_at: realNow + MAX_KEY_LIFETIME_SECONDS },
			{ kind: 'webhook', name: 'github', pending: 0, handed_by: null, held_expires_at: null, expires_at: realNow + MAX_KEY_LIFETIME_SECONDS },
		])

		// A fresh key is neither re-issued nor written again.
		expect(await rotateWorkloadKeys(w.deps)).toEqual({ written: 0, confirmed: 0, busy: 0, failed: 0 })
		expect(w.running.writes).toHaveLength(1)
	})
})

describe('the maintenance pass renews workload keys without a deploy', () => {
	test('a failed write is reported, the key stays pending beside the valid replaced one, and the next pass writes it', async () => {
		const issuer = new RecordingIssuer()
		const clock = { now: 1_800_000_000 }
		const w = await world(issuer, clock)
		const deployed = await w.deploy()
		const deployedAt = clock.now
		clock.now += MAX_KEY_LIFETIME_SECONDS - 10 * DAY
		w.running.failures = 1
		const errors = spyOn(console, 'error').mockImplementation(() => {})
		try {
			expect(await rotateWorkloadKeys(w.deps)).toEqual({ written: 0, confirmed: 0, busy: 0, failed: 1 })
			const lines = errors.mock.calls.map((call) => call.join(' '))
			expect(lines).toEqual([
				'workload keys: notes/prod could not be renewed or handed to the running version, retried next pass: the provider refused the write',
			])
			for (const line of lines) expect(line).not.toContain('px_')
		} finally {
			errors.mockRestore()
		}
		// Both keys stay valid at IAM; the running version holds the replaced one, which expires when the record says.
		expect(issuer.issued.map((issued) => issued.keep)).toEqual([null, null, 'px_job_purgeDeleted_1', 'px_webhook_github_2'])
		for (const key of [...Object.values(deployed), 'px_job_purgeDeleted_3', 'px_webhook_github_4']) expect(issuer.valid.has(key)).toBe(true)
		expect(w.running.held).toEqual(deployed)
		expect(w.records().map((row) => [row['pending'], row['held_expires_at']])).toEqual([
			[1, deployedAt + MAX_KEY_LIFETIME_SECONDS],
			[1, deployedAt + MAX_KEY_LIFETIME_SECONDS],
		])

		clock.now += 300
		expect(await rotateWorkloadKeys(w.deps)).toEqual({ written: 2, confirmed: 0, busy: 0, failed: 0 })
		expect(issuer.issued).toHaveLength(4)
		expect(w.running.held).toEqual({ [JOB_VARIABLE]: 'px_job_purgeDeleted_3', [WEBHOOK_VARIABLE]: 'px_webhook_github_4' })
		expect(w.records().map((row) => row['pending'])).toEqual([0, 0])
	})

	test('a pending key a succeeded deploy handed is confirmed without a write; one a failed deploy handed is written', async () => {
		const issuer = new RecordingIssuer()
		const clock = { now: 1_800_000_000 }
		const w = await world(issuer, clock)
		const runs = w.harness.repositories.runs
		const succeeded = await runs.createRun({ id: uuidv7(), appId: 'notes', env: 'prod', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })
		await w.credentials.reconcile('notes', 'prod', contract, { handedBy: succeeded.id })
		await w.harness.d1.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").bind(succeeded.id).run()
		expect(await rotateWorkloadKeys(w.deps)).toEqual({ written: 0, confirmed: 2, busy: 0, failed: 0 })
		expect(w.running.writes).toEqual([])

		clock.now += MAX_KEY_LIFETIME_SECONDS - 10 * DAY
		const failed = await runs.createRun({ id: uuidv7(), appId: 'notes', env: 'prod', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })
		const handed = await w.credentials.reconcile('notes', 'prod', contract, { handedBy: failed.id })
		await w.harness.d1.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").bind(failed.id).run()
		expect(await rotateWorkloadKeys(w.deps)).toEqual({ written: 2, confirmed: 0, busy: 0, failed: 0 })
		expect(w.running.writes).toEqual([handed.variables])
	})

	test('an environment another holder leases, or with a run still running, is left to the next pass untouched', async () => {
		const issuer = new RecordingIssuer()
		const clock = { now: 1_800_000_000 }
		const w = await world(issuer, clock)
		await w.deploy()
		clock.now += MAX_KEY_LIFETIME_SECONDS - 10 * DAY
		const lease = await acquireLease(w.locks, runLeaseKey('notes', 'prod'))
		expect(await rotateWorkloadKeys(w.deps)).toEqual({ written: 0, confirmed: 0, busy: 1, failed: 0 })
		await lease?.release()
		const run = await w.harness.repositories.runs.createRun({
			id: uuidv7(),
			appId: 'notes',
			env: 'prod',
			ref: 'refs/heads/main',
			trigger: 'manual',
			actor: 'user:test',
		})
		await w.harness.d1.prepare("UPDATE runs SET status = 'running' WHERE id = ?").bind(run.id).run()
		expect(await rotateWorkloadKeys(w.deps)).toEqual({ written: 0, confirmed: 0, busy: 1, failed: 0 })
		expect(issuer.issued).toHaveLength(2)
		expect(w.running.writes).toEqual([])
	})

	test('a pass that no longer holds its lease issues no key', async () => {
		const issuer = new RecordingIssuer()
		const clock = { now: 1_800_000_000 }
		const w = await world(issuer, clock)
		await w.deploy()
		clock.now += MAX_KEY_LIFETIME_SECONDS - 10 * DAY
		const lost = () => {
			throw new Error('the lease was lost')
		}
		await expect(w.credentials.renew('notes', 'prod', contract, lost)).rejects.toThrow('the lease was lost')
		expect(issuer.issued).toHaveLength(2)
		expect(w.records().map((row) => row['pending'])).toEqual([0, 0])
	})

	test('a key another writer recorded meanwhile is not overwritten, and the orphan leaves the vault', async () => {
		const issuer = new RecordingIssuer()
		const clock = { now: 1_800_000_000 }
		const w = await world(issuer, clock)
		await w.deploy()
		clock.now += MAX_KEY_LIFETIME_SECONDS - 10 * DAY
		const vaultRows = () => queryRows(w.harness.sqlite, 'SELECT count(*) AS n FROM vault')[0]?.['n']
		const before = vaultRows()
		issuer.meanwhile = async () => {
			issuer.meanwhile = null
			await w.harness.d1.prepare("UPDATE app_env_workload_credentials SET credential_id = 'px_another_writer' WHERE kind = 'job'").run()
		}
		await expect(w.credentials.renew('notes', 'prod', contract)).rejects.toThrow(
			"the key of the job 'purgeDeleted' was replaced while it was issued; the next pass or deploy retries",
		)
		expect(w.records().map((row) => row['pending'])).toEqual([0, 0])
		expect(queryRows(w.harness.sqlite, "SELECT credential_id FROM app_env_workload_credentials WHERE kind = 'job'")).toEqual([
			{ credential_id: 'px_another_writer' },
		])
		expect(vaultRows()).toBe(before)
	})

	test('a provider that writes no managed credential renews nothing', () => {
		expect(rotatingProvider({ id: 'test', deploy: () => Promise.resolve({ state: 'succeeded' }) })).toBeNull()
		expect(rotatingProvider(undefined)).toBeNull()
	})
})
