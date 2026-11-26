// The maintenance pass warns an application's Operations days before a workload key its running version holds expires
// (`warnExpiringWorkloadKeys`): one warning per environment and day through the application's own ingest, an error once
// the key has expired, the key a pending rotation replaced counted while no deploy or write handed the new one, nothing
// for a renewed key, and a warning Operations did not take sent again by the next pass.

import type { ContractArtifact } from '@fabrika/auth-core'
import { uuidv7 } from '@fabrika/platform'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { Vault } from '../vault'
import { type CredentialKind, VaultWorkloadCredentials, type WorkloadKeyIssuer } from '../workload-credentials'
import { warnExpiringWorkloadKeys } from '../workload-key-expiry'
import { createHarness, queryRows } from './helpers/harness'

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
const DAY = 24 * 60 * 60
const START = 1_800_000_000
const PUBLIC_KEY = 'a'.repeat(32)
const contract: ContractArtifact = { ...notesArtifact, imports: {} }

class Issuer implements WorkloadKeyIssuer {
	count = 0
	issue(input: { app: string; kind: CredentialKind; name: string; expiresAt: number; keep: string | null }) {
		this.count++
		const key = `px_${input.kind}_${input.name}_${this.count}`
		return Promise.resolve({ key, credentialId: key, expiresAt: input.expiresAt })
	}
	revoke() {
		return Promise.resolve()
	}
}

interface Sent {
	readonly url: string
	readonly auth: string | null
	readonly redirect: RequestRedirect
	readonly event: Record<string, unknown>
}

async function world(options: { ingest?: boolean } = {}) {
	const clock = { now: START }
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
	if (options.ingest !== false) {
		await harness.d1.prepare(`INSERT INTO operations_ingest_configs
			(app_id, env, service_key, credential_id, public_key, ingest_project_id, dsn, activated_revision, created_at, updated_at)
			VALUES (?, ?, 'default', ?, ?, '7', ?, 1, ?, ?)`).bind(
			'notes',
			'prod',
			'ingest-credential',
			PUBLIC_KEY,
			`https://${PUBLIC_KEY}@ops.example.test/7`,
			START,
			START,
		).run()
	}
	const vault = await Vault.create(harness.d1, KEY)
	const credentials = new VaultWorkloadCredentials(
		harness.repositories.workloadCredentials,
		() => Promise.resolve(vault),
		new Issuer(),
		() => clock.now,
	)
	const sent: Sent[] = []
	const answers: number[] = []
	const ingest = async (request: Request): Promise<Response> => {
		const lines = (await request.text()).split('\n')
		const event: unknown = JSON.parse(lines[2] ?? 'null')
		sent.push({
			url: request.url,
			auth: request.headers.get('x-sentry-auth'),
			redirect: request.redirect,
			event: typeof event === 'object' && event !== null ? Object.fromEntries(Object.entries(event)) : {},
		})
		return new Response(null, { status: answers.shift() ?? 200 })
	}
	const pass = () => warnExpiringWorkloadKeys({ repositories: harness.repositories, ingest, now: () => clock.now })
	/** A deploy that succeeded: its keys are what the running version holds. */
	const deploy = async () => {
		await credentials.reconcile('notes', 'prod', contract)
		await harness.d1.prepare('UPDATE app_env_workload_credentials SET pending = 0, handed_by = NULL, held_expires_at = NULL').run()
	}
	/** A deploy that hands its keys as the run `status` ends: the maintenance pass reads the run's outcome. */
	const deployAs = async (status: 'succeeded' | 'failed') => {
		const run = await harness.repositories.runs.createRun({
			id: uuidv7(),
			appId: 'notes',
			env: 'prod',
			ref: 'refs/heads/main',
			trigger: 'manual',
			actor: 'user:test',
		})
		await credentials.reconcile('notes', 'prod', contract, { handedBy: run.id })
		await harness.d1.prepare('UPDATE runs SET status = ? WHERE id = ?').bind(status, run.id).run()
		return run.id
	}
	/** The maintenance order: keys a succeeded run handed are confirmed, then the warning pass runs. */
	const maintain = async () => {
		await harness.repositories.workloadCredentials.confirmHanded()
		return await pass()
	}
	const handedBy = () => queryRows(harness.sqlite, 'SELECT pending, handed_by FROM app_env_workload_credentials ORDER BY kind')
	return { clock, harness, credentials, sent, answers, pass, deploy, deployAs, maintain, handedBy }
}

describe('Operations is warned before a workload key the running version holds expires', () => {
	let warn: ReturnType<typeof spyOn> | null = null
	let error: ReturnType<typeof spyOn> | null = null
	afterEach(() => {
		warn?.mockRestore()
		error?.mockRestore()
		warn = null
		error = null
	})

	test('a warning a week ahead, once a day, then an error once the key has expired', async () => {
		warn = spyOn(console, 'warn').mockImplementation(() => {})
		const w = await world()
		await w.deploy()

		w.clock.now = START + 22 * DAY
		expect(await w.pass()).toEqual({ warned: 0, failed: 0 })
		expect(w.sent).toEqual([])

		w.clock.now = START + 24 * DAY
		expect(await w.pass()).toEqual({ warned: 1, failed: 0 })
		expect(w.sent).toHaveLength(1)
		const [first] = w.sent
		expect(first?.url).toBe('https://ops.example.test/api/7/envelope/')
		expect(first?.auth).toBe(`Sentry sentry_version=7, sentry_key=${PUBLIC_KEY}`)
		expect(first?.redirect).toBe('manual')
		const message = "the workload keys of notes/prod (job 'purgeDeleted', webhook 'github') expire in 6 day(s) "
			+ 'and Control could not hand the running version renewed ones; deploy the environment'
		expect(first?.event).toMatchObject({
			level: 'warning',
			logger: 'fabrika.control',
			fingerprint: ['fabrika-workload-key-expiring'],
			environment: 'prod',
			exception: { values: [{ type: 'WorkloadKeyExpiring', value: message }] },
		})
		expect(warn).toHaveBeenCalledWith(`workload keys: ${message}`)

		w.clock.now = START + 24 * DAY + 3600
		expect(await w.pass()).toEqual({ warned: 0, failed: 0 })
		w.clock.now = START + 25 * DAY
		expect(await w.pass()).toEqual({ warned: 1, failed: 0 })
		expect(w.sent).toHaveLength(2)

		w.clock.now = START + 31 * DAY
		await w.pass()
		expect(w.sent.at(-1)?.event).toMatchObject({
			level: 'error',
			exception: {
				values: [{
					value: "the workload keys of notes/prod (job 'purgeDeleted', webhook 'github') have expired "
						+ 'and Control could not hand the running version renewed ones; deploy the environment',
				}],
			},
		})
	})

	test('a renewed key is not warned about; the key a pending rotation replaced is', async () => {
		warn = spyOn(console, 'warn').mockImplementation(() => {})
		const w = await world()
		await w.deploy()
		// A deploy past half-life renews the keys the running version then holds.
		w.clock.now = START + 20 * DAY
		await w.deploy()
		w.clock.now = START + 24 * DAY
		expect(await w.pass()).toEqual({ warned: 0, failed: 0 })

		// The maintenance renewal issued new keys that no write handed: the replaced ones run out at day 50.
		w.clock.now = START + 36 * DAY
		expect((await w.credentials.renew('notes', 'prod', contract)).map((key) => key.name)).toEqual(['purgeDeleted', 'github'])
		w.clock.now = START + 44 * DAY
		expect(await w.pass()).toEqual({ warned: 1, failed: 0 })
		expect(w.sent.at(-1)?.event).toMatchObject({ level: 'warning' })
		expect(JSON.stringify(w.sent.at(-1)?.event)).toContain('expire in 6 day(s)')
	})

	test('a warning Operations did not take is sent again by the next pass; no ingest leaves the log line', async () => {
		warn = spyOn(console, 'warn').mockImplementation(() => {})
		error = spyOn(console, 'error').mockImplementation(() => {})
		const w = await world()
		await w.deploy()
		w.clock.now = START + 24 * DAY
		w.answers.push(503)
		expect(await w.pass()).toEqual({ warned: 0, failed: 1 })
		expect(error).toHaveBeenCalledWith('workload keys: the Operations of notes/prod answered the expiry warning with 503; sent again next pass')
		w.clock.now += 300
		expect(await w.pass()).toEqual({ warned: 1, failed: 0 })
		expect(w.sent).toHaveLength(2)

		const quiet = await world({ ingest: false })
		await quiet.deploy()
		quiet.clock.now = START + 24 * DAY
		expect(await quiet.pass()).toEqual({ warned: 1, failed: 0 })
		expect(quiet.sent).toEqual([])
		quiet.clock.now += 300
		expect(await quiet.pass()).toEqual({ warned: 0, failed: 0 })
	})

	test('on a provider that writes no credential, a failed redeploy past half-life still warns before the running key expires', async () => {
		warn = spyOn(console, 'warn').mockImplementation(() => {})
		const w = await world()
		await w.deployAs('succeeded')
		await w.maintain()
		expect(w.handedBy()).toEqual([{ pending: 0, handed_by: null }, { pending: 0, handed_by: null }])

		// Day 16: the redeploy issues new keys and fails; the running version still holds the day-0 keys, valid to day 30.
		w.clock.now = START + 16 * DAY
		await w.deployAs('failed')
		w.clock.now = START + 24 * DAY
		expect(await w.maintain()).toEqual({ warned: 1, failed: 0 })
		expect(JSON.stringify(w.sent.at(-1)?.event)).toContain('expire in 6 day(s)')
	})

	test('a later run does not take over a key a succeeded run handed, and the pass confirms it', async () => {
		const w = await world()
		const succeeded = await w.deployAs('succeeded')
		// A run that reads the same fresh keys back and fails, before the pass confirmed them.
		await w.deployAs('failed')
		expect(w.handedBy()).toEqual([{ pending: 1, handed_by: succeeded }, { pending: 1, handed_by: succeeded }])
		expect(await w.harness.repositories.workloadCredentials.confirmHanded()).toBe(2)
		expect(w.handedBy()).toEqual([{ pending: 0, handed_by: null }, { pending: 0, handed_by: null }])
	})

	test('a refusal is logged once and not sent again that day; a dev environment is never warned', async () => {
		warn = spyOn(console, 'warn').mockImplementation(() => {})
		error = spyOn(console, 'error').mockImplementation(() => {})
		const w = await world()
		await w.deploy()
		w.clock.now = START + 24 * DAY
		w.answers.push(401)
		expect(await w.pass()).toEqual({ warned: 1, failed: 0 })
		expect(error).toHaveBeenCalledWith('workload keys: the Operations of notes/prod refused the expiry warning with 401; not sent again today')
		w.clock.now += 300
		expect(await w.pass()).toEqual({ warned: 0, failed: 0 })
		expect(w.sent).toHaveLength(1)

		const dev = await world()
		await dev.deploy()
		await dev.harness.d1.prepare("UPDATE app_envs SET kind = 'dev'").run()
		dev.clock.now = START + 24 * DAY
		expect(await dev.pass()).toEqual({ warned: 0, failed: 0 })
		expect(dev.sent).toEqual([])
	})

	test('a redirect is an answer Operations did not take, and is not followed', async () => {
		error = spyOn(console, 'error').mockImplementation(() => {})
		warn = spyOn(console, 'warn').mockImplementation(() => {})
		const w = await world()
		await w.deploy()
		w.clock.now = START + 24 * DAY
		w.answers.push(307)
		expect(await w.pass()).toEqual({ warned: 0, failed: 1 })
		expect(w.sent).toHaveLength(1)
		expect(w.sent[0]?.redirect).toBe('manual')
	})
})
