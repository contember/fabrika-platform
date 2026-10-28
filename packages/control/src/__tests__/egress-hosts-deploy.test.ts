// A deploy whose approved contract has a cron job with `egress: 'public'` hands the provider the installation's hosts
// (`FABRIKA_EGRESS_REFUSED_HOSTS`, ADR-0071): Control's, IAM's and every environment's domain and public origin. A
// contract without such a job hands `null`, which removes a stale list.

import { FABRIKA_EGRESS_REFUSED_HOSTS } from '@fabrika/auth-core'
import { uuidv7 } from '@fabrika/platform'
import type { ControlProvider, ProviderDeployInput } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { executeDeploy, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { Vault } from '../vault'
import { VaultWorkloadCredentials, type WorkloadKeyIssuer } from '../workload-credentials'
import { memoryCommits } from './helpers/commits'
import { createHarness, harnessDatabase } from './helpers/harness'
import { kitFiles, NOTES_MIGRATION } from './helpers/kit-contract'
import { fixtureProtect, makeFakeLock } from './helpers/lock'

const COMMIT = 'c'.repeat(40)
const ENVELOPE = JSON.stringify({ provider: 'harbor', version: 1, payload: {} })

const CRAWL = `import { app } from '../app-kit'

export const crawl = app.cron('*/5 * * * *', { actions: ['notes.read'], egress: 'public' }).handle(async ({ ctx }) => {
	await fetch('https://www.example.com/', { signal: ctx.signal })
})
`

const WITH_CRAWL = `import { app } from './src/app-kit'
import { crawl } from './src/crawl/job'
import { notes } from './src/notes/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { notes }),
	health: c.health('/healthz'),
	jobs: { crawl },
}))
`

function files(crawler: boolean): Record<string, string> {
	return {
		...kitFiles(),
		...(crawler ? { 'fabrika.contract.ts': WITH_CRAWL, 'src/crawl/job.ts': CRAWL } : {}),
		[`db/migrations/${NOTES_MIGRATION.name}`]: NOTES_MIGRATION.sql,
	}
}

async function handed(crawler: boolean): Promise<string | null | undefined> {
	const { db } = createHarness()
	await db.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
	await db.registry.createApp({ id: 'crm', repoUrl: 'github.com/acme/crm' })
	for (
		const [appId, env, domain, publicOrigin] of [
			['notes', 'prod', 'notes.acme.cz', 'https://notes.acme.cz'],
			['notes', 'stage', 'stage.notes.acme.cz', null],
			['crm', 'prod', 'crm.acme.cz', 'https://crm.client.com'],
		] as const
	) {
		await db.registry.upsertAppEnv({
			appId,
			env,
			domain,
			...(publicOrigin === null ? {} : { publicOrigin }),
			namespaceId: null,
			provider: 'harbor',
			providerTargetJson: ENVELOPE,
			providerArtifactJson: ENVELOPE,
		})
	}
	// Unprotected, so the first contract publishes without an approval (ADR-0050).
	await fixtureProtect(db.registry, makeFakeLock(db), { appId: 'notes', env: 'prod' }, false)
	const inputs: ProviderDeployInput[] = []
	const provider: ControlProvider = {
		id: 'harbor',
		normalizeRegistration: (input) => input,
		applicationRoot: () => '',
		resolveSource: () => Promise.resolve({ commitSha: COMMIT }),
		deploy: (input) => {
			inputs.push(input)
			return Promise.resolve({ state: 'succeeded' })
		},
	}
	// The crawl job's key, from a vault and a stand-in IAM.
	const vault = await Vault.create(harnessDatabase(db), btoa(String.fromCharCode(...new Uint8Array(32).fill(7))))
	const issuer: WorkloadKeyIssuer = {
		issue: (input) => Promise.resolve({ key: `px_${'k'.repeat(40)}`, credentialId: 'credential-1', expiresAt: input.expiresAt }),
		revoke: () => Promise.resolve(),
	}
	const deps: RunDeps = {
		workloadCredentials: new VaultWorkloadCredentials(db.workloadCredentials, () => Promise.resolve(vault), issuer),
		repositories: db,
		provider,
		secrets: new VaultSecretResolver({}),
		lock: makeFakeLock(db),
		queue: { send: () => Promise.resolve() },
		logs: { put: () => Promise.resolve() },
		commits: { ...memoryCommits(), open: (input) => memoryCommits(files(crawler)).open(input) },
		controlOrigin: 'https://control.acme.cz',
		iamIssuer: 'https://iam.acme.cz',
	}
	const runId = uuidv7()
	await db.runs.createRun({ id: runId, appId: 'notes', env: 'prod', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })
	expect((await executeDeploy(deps, { runId })).status).toBe('succeeded')
	const entry = inputs[0]?.managedEnvironment[FABRIKA_EGRESS_REFUSED_HOSTS]
	expect(entry?.credential).toBe(false)
	return entry?.value
}

describe('the installation hosts a deploy hands', () => {
	test("a contract with a job that declares egress: 'public' gets every host of the installation", async () => {
		expect(await handed(true)).toBe('control.acme.cz,crm.acme.cz,crm.client.com,iam.acme.cz,notes.acme.cz,stage.notes.acme.cz')
	})

	test('a contract without one gets null, which removes the variable', async () => {
		expect(await handed(false)).toBeNull()
	})
})
