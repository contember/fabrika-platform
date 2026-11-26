// The maintenance pass reads an environment's exposure back between deploys (`watchExposure`): an environment that
// stays as its last deploy verified raises nothing; one that became exposed raises one error event in its own
// Operations, not again while the same exposure lasts, again when it changes or returns after it was gone; an alert
// Operations did not take is sent again by the next pass; an environment a run or another holder has waits, a dev
// environment is not read, and a read that does not answer is abandoned at its timeout.

import { SqlDeployLocks, uuidv7 } from '@fabrika/platform'
import type { ControlProvider, ProviderExposureFinding } from '@fabrika/provider-contract'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { exposureProvider, watchExposure } from '../exposure-watch'
import { acquireLease, runLeaseKey } from '../lease'
import { createHarness, queryRows } from './helpers/harness'

const START = 1_800_000_000
const PUBLIC_KEY = 'b'.repeat(32)
const SUBDOMAIN: ProviderExposureFinding = { service: 'notes', reason: 'has a `.zerops.app` subdomain' }
const BUCKET: ProviderExposureFinding = { service: 'files', reason: 'is a bucket the platform did not create private' }

interface Sent {
	readonly url: string
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
	/** What the provider reads back on the next check; a thrown error is a failed read, `hang` never answers. */
	const live: { findings: readonly ProviderExposureFinding[] | Error | 'hang' } = { findings: [] }
	const checked: string[] = []
	const fake: ControlProvider = {
		id: 'test',
		deploy: () => Promise.resolve({ state: 'succeeded' }),
		exposure: {
			check: ({ environment, signal }) => {
				checked.push(`${environment.appId}/${environment.env}`)
				const findings = live.findings
				if (findings === 'hang') {
					return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('zerops: find service was aborted'))))
				}
				return findings instanceof Error ? Promise.reject(findings) : Promise.resolve(findings)
			},
		},
	}
	const provider = exposureProvider(fake)
	if (provider === null) throw new Error('the fake provider reads exposure back')
	const sent: Sent[] = []
	const answers: number[] = []
	const ingest = async (request: Request): Promise<Response> => {
		const event: unknown = JSON.parse((await request.text()).split('\n')[2] ?? 'null')
		sent.push({
			url: request.url,
			redirect: request.redirect,
			event: typeof event === 'object' && event !== null ? Object.fromEntries(Object.entries(event)) : {},
		})
		return new Response(null, { status: answers.shift() ?? 200 })
	}
	const locks = new SqlDeployLocks(harness.d1)
	const pass = () => watchExposure({ repositories: harness.repositories, provider, locks, ingest, now: () => clock.now, checkTimeoutMs: 50 })
	const recorded = () => queryRows(harness.sqlite, 'SELECT exposure, alerted_at FROM app_env_exposure_alerts')
	return { clock, harness, live, checked, sent, answers, locks, pass, recorded }
}

describe('the maintenance pass alerts Operations when an environment becomes exposed between deploys', () => {
	const spies: ReturnType<typeof spyOn>[] = []
	afterEach(() => {
		for (const spy of spies.splice(0)) spy.mockRestore()
	})
	const quiet = () => {
		const warn = spyOn(console, 'warn').mockImplementation(() => {})
		const error = spyOn(console, 'error').mockImplementation(() => {})
		const info = spyOn(console, 'info').mockImplementation(() => {})
		spies.push(warn, error, info)
		return { warn, error, info }
	}

	test('an environment as its last deploy verified it raises nothing', async () => {
		const logs = quiet()
		const w = await world()

		expect(await w.pass()).toEqual({ checked: 1, alerted: 0, cleared: 0, busy: 0, failed: 0 })
		expect(await w.pass()).toEqual({ checked: 1, alerted: 0, cleared: 0, busy: 0, failed: 0 })
		expect(w.checked).toEqual(['notes/prod', 'notes/prod'])
		expect(w.sent).toEqual([])
		expect(w.recorded()).toEqual([])
		expect(logs.warn).not.toHaveBeenCalled()
	})

	test('a newly exposed environment raises one error event, and not again while the exposure lasts', async () => {
		const logs = quiet()
		const w = await world()
		expect(await w.pass()).toEqual({ checked: 1, alerted: 0, cleared: 0, busy: 0, failed: 0 })

		w.live.findings = [SUBDOMAIN]
		w.clock.now = START + 300
		expect(await w.pass()).toEqual({ checked: 1, alerted: 1, cleared: 0, busy: 0, failed: 0 })
		const message = 'notes/prod became reachable past its proxy since its last deploy: service `notes` has a `.zerops.app` subdomain'
		expect(w.sent).toHaveLength(1)
		expect(w.sent[0]?.url).toBe('https://ops.example.test/api/7/envelope/')
		expect(w.sent[0]?.redirect).toBe('manual')
		expect(w.sent[0]?.event).toMatchObject({
			level: 'error',
			logger: 'fabrika.control',
			environment: 'prod',
			fingerprint: ['fabrika-exposure-detected', 'notes', 'prod', 'notes', String(START + 300)],
			exception: { values: [{ type: 'FabrikaExposureDetected', value: message }] },
		})
		expect(logs.warn).toHaveBeenCalledWith(`exposure: ${message}`)
		expect(w.recorded()).toEqual([{ exposure: JSON.stringify([[SUBDOMAIN.service, SUBDOMAIN.reason]]), alerted_at: START + 300 }])

		w.clock.now = START + 600
		expect(await w.pass()).toEqual({ checked: 1, alerted: 0, cleared: 0, busy: 0, failed: 0 })
		expect(w.sent).toHaveLength(1)
	})

	test('a changed exposure raises again, in any order of findings; a cleared one is forgotten and raises when it returns', async () => {
		const logs = quiet()
		const w = await world()
		w.live.findings = [SUBDOMAIN]
		await w.pass()

		w.live.findings = [SUBDOMAIN, BUCKET]
		expect(await w.pass()).toEqual({ checked: 1, alerted: 1, cleared: 0, busy: 0, failed: 0 })
		expect(w.sent.at(-1)?.event).toMatchObject({ fingerprint: ['fabrika-exposure-detected', 'notes', 'prod', 'files', 'notes', String(START)] })
		w.live.findings = [BUCKET, SUBDOMAIN]
		expect(await w.pass()).toEqual({ checked: 1, alerted: 0, cleared: 0, busy: 0, failed: 0 })

		w.live.findings = []
		expect(await w.pass()).toEqual({ checked: 1, alerted: 0, cleared: 1, busy: 0, failed: 0 })
		expect(logs.info).toHaveBeenCalledWith('exposure: notes/prod no longer exposes a service past its proxy')
		expect(w.recorded()).toEqual([])

		// The same exposure again is a new Operations issue, so its new_issue rules notify it again.
		w.live.findings = [SUBDOMAIN]
		w.clock.now = START + 900
		expect(await w.pass()).toEqual({ checked: 1, alerted: 1, cleared: 0, busy: 0, failed: 0 })
		expect(w.sent).toHaveLength(3)
		expect(w.sent[0]?.event['fingerprint']).toEqual(['fabrika-exposure-detected', 'notes', 'prod', 'notes', String(START)])
		expect(w.sent[2]?.event['fingerprint']).toEqual(['fabrika-exposure-detected', 'notes', 'prod', 'notes', String(START + 900)])
	})

	test('an alert Operations did not take is sent again by the next pass; without an ingest the log line stands', async () => {
		const logs = quiet()
		const w = await world()
		w.live.findings = [SUBDOMAIN]
		w.answers.push(503)
		expect(await w.pass()).toEqual({ checked: 1, alerted: 0, cleared: 0, busy: 0, failed: 1 })
		expect(logs.error).toHaveBeenCalledWith('exposure: the Operations of notes/prod answered the alert with 503; sent again next pass')
		expect(w.recorded()).toEqual([])
		expect(await w.pass()).toEqual({ checked: 1, alerted: 1, cleared: 0, busy: 0, failed: 0 })
		expect(w.sent).toHaveLength(2)

		const refusing = await world()
		refusing.live.findings = [SUBDOMAIN]
		refusing.answers.push(403)
		expect(await refusing.pass()).toEqual({ checked: 1, alerted: 1, cleared: 0, busy: 0, failed: 0 })
		expect(logs.error).toHaveBeenCalledWith('exposure: the Operations of notes/prod refused the alert with 403; not sent again while it lasts')
		expect(await refusing.pass()).toEqual({ checked: 1, alerted: 0, cleared: 0, busy: 0, failed: 0 })
		expect(refusing.sent).toHaveLength(1)

		const bare = await world({ ingest: false })
		bare.live.findings = [SUBDOMAIN]
		expect(await bare.pass()).toEqual({ checked: 1, alerted: 1, cleared: 0, busy: 0, failed: 0 })
		expect(bare.sent).toEqual([])
		expect(bare.recorded()).toHaveLength(1)
	})

	test('an environment another holder has waits for the next pass; a failed read changes nothing', async () => {
		const logs = quiet()
		const w = await world()
		w.live.findings = [SUBDOMAIN]
		const held = await acquireLease(w.locks, runLeaseKey('notes', 'prod'))
		if (held === null) throw new Error('expected the lease')
		expect(await w.pass()).toEqual({ checked: 0, alerted: 0, cleared: 0, busy: 1, failed: 0 })
		expect(w.checked).toEqual([])
		await held.release()

		w.live.findings = new Error('zerops: find service answered 503')
		expect(await w.pass()).toEqual({ checked: 0, alerted: 0, cleared: 0, busy: 0, failed: 1 })
		expect(logs.error).toHaveBeenCalledWith('exposure: notes/prod could not be read back, retried next pass: zerops: find service answered 503')
		expect(w.sent).toEqual([])
		expect(w.recorded()).toEqual([])
	})

	test('a read that does not answer is abandoned at its timeout, and the pass goes on', async () => {
		const logs = quiet()
		const w = await world()
		w.live.findings = 'hang'
		expect(await w.pass()).toEqual({ checked: 0, alerted: 0, cleared: 0, busy: 0, failed: 1 })
		expect(logs.error).toHaveBeenCalledWith('exposure: notes/prod could not be read back, retried next pass: zerops: find service was aborted')
		const lease = await acquireLease(w.locks, runLeaseKey('notes', 'prod'))
		expect(lease).not.toBeNull()
		await lease?.release()
	})

	test('a dev environment is not read, nor one whose run still runs', async () => {
		quiet()
		const w = await world()
		w.live.findings = [SUBDOMAIN]
		await w.harness.d1.prepare("UPDATE app_envs SET kind = 'dev' WHERE app_id = 'notes' AND env = 'prod'").run()
		expect(await w.pass()).toEqual({ checked: 0, alerted: 0, cleared: 0, busy: 0, failed: 0 })
		await w.harness.d1.prepare("UPDATE app_envs SET kind = 'standard' WHERE app_id = 'notes' AND env = 'prod'").run()

		const run = await w.harness.repositories.runs.createRun({
			id: uuidv7(),
			appId: 'notes',
			env: 'prod',
			ref: 'refs/heads/main',
			trigger: 'manual',
			actor: 'user:test',
		})
		await w.harness.d1.prepare("UPDATE runs SET status = 'running' WHERE id = ?").bind(run.id).run()
		expect(await w.pass()).toEqual({ checked: 0, alerted: 0, cleared: 0, busy: 1, failed: 0 })
		expect(w.checked).toEqual([])
		expect(w.sent).toEqual([])
	})
})
