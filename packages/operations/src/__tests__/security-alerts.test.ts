import type { IamSignInSignalsRpc, SignInSignalsInput, SignInSignalsResult } from '@fabrika/auth-core'
import { operationsCatalogSnapshotHash } from '@fabrika/operations-contract/catalog'
import { describe, expect, test } from 'bun:test'
import { reconcileOperationsCatalog } from '../catalog.js'
import { INSTALLATION_SOURCE } from '../installation-source.js'
import { OperationsMaintenance } from '../maintenance.js'
import { bindingSignInSignals } from '../platform-cf.js'
import { OperationsSecurityAlertProducer, SECURITY_ALERT_REPEAT_MS, SECURITY_REFUSAL_WINDOW_MS } from '../security-alerts.js'
import { createHarness, type OperationsHarness } from './helpers/sqlite.js'

const START = 1_800_000_000_000
const MINUTE = 60_000

function answer(overrides: Partial<Extract<SignInSignalsResult, { ok: true }>> = {}): SignInSignalsResult {
	return { ok: true, accounts: [], refusals: 0, reasons: [], privileged: [], accountsTruncated: false, privilegedTruncated: false, ...overrides }
}

/** A fake IAM: the answer the next call gets, and every window it was asked for. */
class FakeIam implements IamSignInSignalsRpc {
	readonly calls: SignInSignalsInput[] = []
	next: SignInSignalsResult | Error = answer()

	signInSignals(input: SignInSignalsInput): Promise<SignInSignalsResult> {
		this.calls.push(input)
		return this.next instanceof Error ? Promise.reject(this.next) : Promise.resolve(this.next)
	}
}

interface Setup {
	harness: OperationsHarness
	iam: FakeIam
	logs: string[]
	clock: { now: number }
	producer: OperationsSecurityAlertProducer
	sourceId: string
}

async function setup(options: { configure?: boolean } = {}): Promise<Setup> {
	const clock = { now: START }
	const harness = createHarness(() => clock.now)
	const iam = new FakeIam()
	const logs: string[] = []
	const producer = new OperationsSecurityAlertProducer(harness.repositories.alerts, harness.repositories.security, iam, {
		now: () => clock.now,
		logger: { warn: (message) => logs.push(message) },
	})
	const source = await harness.repositories.security.ensureInstallationSource()
	if (source === null) throw new Error('installation source was not created')
	if (options.configure !== false) {
		await harness.repositories.alerts.setRule(source.id, 'security', true)
		await harness.repositories.alerts.upsertChannel({
			id: 'security-channel',
			sourceId: source.id,
			scope: 'security',
			type: 'webhook',
			target: 'https://hooks.example.test/security',
			enabled: true,
		})
	}
	return { harness, iam, logs, clock, producer, sourceId: source.id }
}

function outbox(harness: OperationsHarness): { kind: string; dedup_key: string; payload: Record<string, unknown> }[] {
	return harness.sqlite
		.query<{ kind: string; dedup_key: string; payload: string }, []>('SELECT kind, dedup_key, payload FROM notification_outbox ORDER BY created_at, id')
		.all()
		.map((row) => {
			const payload: Record<string, unknown> = JSON.parse(row.payload)
			return { kind: row.kind, dedup_key: row.dedup_key, payload }
		})
}

describe('security alerts from IAM sign-in signals', () => {
	test('after an outage refusals are still counted over fifteen minutes, while privileged sign-ins are read from the mark', async () => {
		const { iam, producer, clock, harness } = await setup()
		expect((await producer.run()).status).toBe('evaluated')
		clock.now += 6 * 60 * MINUTE
		expect((await producer.run()).status).toBe('evaluated')
		expect(iam.calls.at(-1)).toEqual({
			since: (START - SECURITY_REFUSAL_WINDOW_MS) / 1_000,
			refusalsSince: (clock.now - SECURITY_REFUSAL_WINDOW_MS) / 1_000,
			until: clock.now / 1_000,
		})
		expect(await harness.repositories.security.evaluatedUntil()).toBe(clock.now)
	})

	test('a cut privileged list moves the mark to its last listed sign-in, and the re-read alerts nothing twice', async () => {
		const { iam, producer, clock, harness } = await setup()
		const first = { id: '1', principalId: 'admin-a', reason: 'password_login', at: (START - 10 * MINUTE) / 1_000 }
		const second = { id: '2', principalId: 'admin-b', reason: 'password_login', at: (START - 5 * MINUTE) / 1_000 }
		iam.next = answer({ privileged: [first, second], privilegedTruncated: true })
		expect(await producer.run()).toEqual({ status: 'evaluated', enqueued: 2, deduplicated: 0 })
		expect(await harness.repositories.security.evaluatedUntil()).toBe(second.at * 1_000)

		clock.now += MINUTE
		const third = { id: '3', principalId: 'admin-c', reason: 'password_login', at: (START - 4 * MINUTE) / 1_000 }
		iam.next = answer({ privileged: [second, third] })
		expect(await producer.run()).toEqual({ status: 'evaluated', enqueued: 1, deduplicated: 1 })
		expect(iam.calls.at(-1)?.since).toBe((second.at * 1_000 - SECURITY_REFUSAL_WINDOW_MS) / 1_000)
		expect(await harness.repositories.security.evaluatedUntil()).toBe(clock.now)
	})

	test('an alert that did not reach the outbox gives its claim back, so the next pass raises it', async () => {
		const { iam, producer, clock, harness } = await setup()
		iam.next = answer({ accounts: [{ principalId: 'account-a', refusals: 5 }], refusals: 5 })
		harness.sqlite.exec(`CREATE TRIGGER refuse_outbox BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(ABORT, 'outbox down'); END`)
		await expect(producer.run()).rejects.toThrow('outbox down')
		harness.sqlite.exec('DROP TRIGGER refuse_outbox')

		clock.now += MINUTE
		expect(await producer.run()).toEqual({ status: 'evaluated', enqueued: 1, deduplicated: 0 })
		expect(outbox(harness)).toHaveLength(1)
	})

	test('five refused sign-ins of one account raise one alert, and the overlapping next pass raises none', async () => {
		const { harness, iam, producer, clock } = await setup()
		iam.next = answer({ accounts: [{ principalId: 'account-a', refusals: 5 }], refusals: 5, reasons: [{ reason: 'password_invalid', refusals: 5 }] })
		expect(await producer.run()).toEqual({ status: 'evaluated', enqueued: 1, deduplicated: 0 })
		// The first pass reads the counting window before now.
		expect(iam.calls[0]).toEqual({
			since: (START - SECURITY_REFUSAL_WINDOW_MS) / 1_000,
			refusalsSince: (START - SECURITY_REFUSAL_WINDOW_MS) / 1_000,
			until: START / 1_000,
		})
		expect(outbox(harness)).toEqual([{
			kind: 'security',
			dedup_key: expect.stringContaining('security:account:'),
			payload: expect.objectContaining({ type: 'security', signal: 'account_refusals', principalId: 'account-a', refusals: 5, threshold: 5 }),
		}])
		expect(JSON.stringify(outbox(harness))).not.toContain('@')

		clock.now += MINUTE
		iam.next = answer({ accounts: [{ principalId: 'account-a', refusals: 6 }], refusals: 6 })
		expect(await producer.run()).toEqual({ status: 'evaluated', enqueued: 0, deduplicated: 1 })
		// The next pass overlaps: it reads from the previous mark minus the window.
		expect(iam.calls[1]).toEqual({
			since: (START - SECURITY_REFUSAL_WINDOW_MS) / 1_000,
			refusalsSince: (START + MINUTE - SECURITY_REFUSAL_WINDOW_MS) / 1_000,
			until: (START + MINUTE) / 1_000,
		})
		expect(outbox(harness)).toHaveLength(1)

		// After the repeat interval the same account alerts again.
		clock.now = START + SECURITY_ALERT_REPEAT_MS + MINUTE
		expect((await producer.run()).status).toBe('evaluated')
		expect(outbox(harness)).toHaveLength(2)
	})

	test('four refusals raise nothing by default; a configured threshold of three raises, one of ten does not', async () => {
		const { harness, iam, producer, sourceId } = await setup()
		iam.next = answer({ accounts: [{ principalId: 'account-a', refusals: 4 }], refusals: 4 })
		expect(await producer.run()).toEqual({ status: 'evaluated', enqueued: 0, deduplicated: 0 })
		await harness.repositories.security.setConfig(sourceId, { accountThreshold: 3, installationThreshold: 50 })
		expect(await producer.run()).toEqual({ status: 'evaluated', enqueued: 1, deduplicated: 0 })

		const other = await setup()
		await other.harness.repositories.security.setConfig(other.sourceId, { accountThreshold: 10, installationThreshold: 50 })
		other.iam.next = answer({ accounts: [{ principalId: 'account-a', refusals: 5 }], refusals: 5 })
		expect(await other.producer.run()).toEqual({ status: 'evaluated', enqueued: 0, deduplicated: 0 })
	})

	test('fifty refusals across the installation raise one installation-wide alert per hour', async () => {
		const { harness, iam, producer, clock } = await setup()
		// Unknown accounts and refused keys have no account: they count only installation-wide.
		const reasons = [{ reason: 'invalid_key', refusals: 20 }, { reason: 'password_invalid', refusals: 30 }]
		iam.next = answer({ refusals: 50, reasons })
		expect(await producer.run()).toEqual({ status: 'evaluated', enqueued: 1, deduplicated: 0 })
		expect(outbox(harness)[0]?.payload).toMatchObject({ signal: 'installation_refusals', refusals: 50, threshold: 50, reasons })
		clock.now += MINUTE
		expect(await producer.run()).toEqual({ status: 'evaluated', enqueued: 0, deduplicated: 1 })
		iam.next = answer({ refusals: 49 })
		clock.now += SECURITY_ALERT_REPEAT_MS
		expect(await producer.run()).toEqual({ status: 'evaluated', enqueued: 0, deduplicated: 0 })
	})

	test('a privileged sign-in raises one alert, once, however often its window is read', async () => {
		const { harness, iam, producer, clock } = await setup()
		iam.next = answer({ privileged: [{ id: '42', principalId: 'admin-a', reason: 'password_login', at: START / 1_000 - 30 }] })
		expect(await producer.run()).toEqual({ status: 'evaluated', enqueued: 1, deduplicated: 0 })
		clock.now += MINUTE
		expect(await producer.run()).toEqual({ status: 'evaluated', enqueued: 0, deduplicated: 1 })
		expect(outbox(harness).map((row) => row.payload)).toEqual([{
			text: 'Fabrika Operations: privileged sign-in by admin-a',
			type: 'security',
			signal: 'privileged_sign_in',
			sourceId: expect.any(String),
			principalId: 'admin-a',
			authLogId: '42',
			reason: 'password_login',
			at: START - 30_000,
		}])
	})

	test('an unavailable IAM or one without the method leaves the mark, and the next pass reads the same time', async () => {
		const { harness, iam, producer, logs, clock } = await setup()
		await producer.run()
		expect(await harness.repositories.security.evaluatedUntil()).toBe(START)

		clock.now += MINUTE
		iam.next = new Error('iam unavailable: http://iam:3000 with key secret-key')
		expect(await producer.run()).toEqual({ status: 'skipped', reason: 'iam_unavailable' })
		expect(await harness.repositories.security.evaluatedUntil()).toBe(START)
		clock.now += MINUTE
		iam.next = { ok: false, reason: 'invalid_window' }
		expect(await producer.run()).toEqual({ status: 'skipped', reason: 'iam_unavailable' })
		expect(await harness.repositories.security.evaluatedUntil()).toBe(START)
		expect(logs).toEqual([
			'operations security alerts skipped: IAM did not answer the sign-in signals; the next pass retries',
			'operations security alerts skipped: IAM did not answer the sign-in signals; the next pass retries',
		])

		clock.now += MINUTE
		iam.next = answer()
		expect((await producer.run()).status).toBe('evaluated')
		expect(iam.calls.at(-1)).toEqual({
			since: (START - SECURITY_REFUSAL_WINDOW_MS) / 1_000,
			refusalsSince: (clock.now - SECURITY_REFUSAL_WINDOW_MS) / 1_000,
			until: clock.now / 1_000,
		})
		expect(await harness.repositories.security.evaluatedUntil()).toBe(clock.now)
	})

	test('an IAM binding that rejects the call, as an older IAM does, is unavailable; a body off the contract too', async () => {
		const { harness, clock } = await setup()
		const reject = bindingSignInSignals({ signInSignals: () => Promise.reject(new Error('the RPC receiver does not implement the method')) })
		const offContract = bindingSignInSignals({ signInSignals: () => Promise.resolve({ ok: true, accounts: 'none' }) })
		for (const binding of [reject, offContract]) {
			const producer = new OperationsSecurityAlertProducer(harness.repositories.alerts, harness.repositories.security, binding, {
				now: () => clock.now,
				logger: { warn: () => {} },
			})
			expect(await producer.run()).toEqual({ status: 'skipped', reason: 'iam_unavailable' })
		}
		const decoded = bindingSignInSignals({ signInSignals: (input: unknown) => Promise.resolve({ ...answer(), echoed: input }) })
		expect(await decoded?.signInSignals({ since: 1, refusalsSince: 1, until: 2 })).toEqual(answer())
	})

	test('without a security rule and channel IAM is not asked, and enabling later raises nothing for the time before', async () => {
		const { harness, iam, producer, clock, sourceId } = await setup({ configure: false })
		expect(await producer.run()).toEqual({ status: 'unconfigured' })
		expect(iam.calls).toEqual([])
		expect(await harness.repositories.security.evaluatedUntil()).toBeNull()

		await harness.repositories.alerts.setRule(sourceId, 'security', true)
		await harness.repositories.alerts.upsertChannel({
			id: 'security-channel',
			sourceId,
			scope: 'security',
			type: 'webhook',
			target: 'https://hooks.example.test/security',
			enabled: true,
		})
		clock.now += 6 * 60 * MINUTE
		expect((await producer.run()).status).toBe('evaluated')
		expect(iam.calls).toEqual([{
			since: (clock.now - SECURITY_REFUSAL_WINDOW_MS) / 1_000,
			refusalsSince: (clock.now - SECURITY_REFUSAL_WINDOW_MS) / 1_000,
			until: clock.now / 1_000,
		}])
	})

	test('an application source with a security channel raises nothing: the alerts land on the installation source only', async () => {
		const { harness, iam, producer, sourceId } = await setup()
		await harness.repositories.sources.upsert({ id: 'app-source', appId: 'app-a', environment: 'production', displayName: 'A', enabled: true })
		await harness.repositories.alerts.setRule('app-source', 'security', true)
		await harness.repositories.alerts.upsertChannel({
			id: 'app-security-channel',
			sourceId: 'app-source',
			scope: 'security',
			type: 'webhook',
			target: 'https://hooks.example.test/app',
			enabled: true,
		})
		iam.next = answer({ accounts: [{ principalId: 'account-a', refusals: 9 }], refusals: 9 })
		expect(await producer.run()).toEqual({ status: 'evaluated', enqueued: 1, deduplicated: 0 })
		expect(harness.sqlite.query<{ source_id: string }, []>('SELECT DISTINCT source_id FROM notification_outbox').all()).toEqual([
			{ source_id: sourceId },
		])
	})

	test('the maintenance pass delivers a security alert ahead of an older issue alert', async () => {
		const { harness, iam, producer, sourceId } = await setup()
		await harness.repositories.sources.upsert({ id: 'app-source', appId: 'app-a', environment: 'production', displayName: 'A', enabled: true })
		await harness.repositories.alerts.upsertChannel({
			id: 'issue-channel',
			sourceId: 'app-source',
			scope: 'new_issue',
			type: 'webhook',
			target: 'https://hooks.example.test/issues',
			enabled: true,
		})
		await harness.repositories.alerts.enqueueNotification({
			dedupKey: 'new_issue:app-source:fp',
			sourceId: 'app-source',
			channelId: 'issue-channel',
			kind: 'new_issue',
			payload: {},
		})
		iam.next = answer({ privileged: [{ id: '7', principalId: 'admin-a', reason: 'password_login', at: START / 1_000 }] })
		const sent: string[] = []
		const maintenance = new OperationsMaintenance(harness.repositories.alerts, {
			send: (input) => {
				sent.push(input.idempotencyKey)
				return Promise.resolve()
			},
		}, { batchSize: 1, securityAlerts: producer })
		const result = await maintenance.run()
		expect(result.security).toEqual({ status: 'evaluated', enqueued: 1, deduplicated: 0 })
		expect(sent).toEqual([`security:privileged:${sourceId}:7:security-channel`])
	})
})

describe('the installation source', () => {
	test('is created on an existing installation, once, beside the Control sources', async () => {
		const harness = createHarness(() => START)
		await harness.repositories.sources.upsert({ id: 'app-source', appId: 'app-a', environment: 'production', displayName: 'A', enabled: true })
		const first = await harness.repositories.security.ensureInstallationSource()
		const second = await harness.repositories.security.ensureInstallationSource()
		expect(second?.id).toBe(first?.id ?? 'missing')
		expect(first).toMatchObject({
			app_id: INSTALLATION_SOURCE.appId,
			environment: INSTALLATION_SOURCE.environment,
			service_key: 'default',
			origin: 'installation',
			enabled: 1,
		})
		expect((await harness.repositories.sources.list()).map((source) => source.origin).sort()).toEqual(['control', 'installation'])
	})

	test('the catalog reconcile leaves it alone, and Control cannot reach it by coordinate', async () => {
		let now = START
		const harness = createHarness(() => now)
		const installation = await harness.repositories.security.ensureInstallationSource()
		const snapshot = async (revision: number, appIds: string[]) => {
			const sources = appIds.map((appId) => ({
				coordinate: { appId, environment: 'production' },
				displayName: appId,
				ingestCredential: { id: `0198a000-0000-7000-8000-00000000000${revision}`, publicKey: '0123456789abcdef0123456789abcdef' },
			}))
			return { revision, snapshotHash: await operationsCatalogSnapshotHash(sources), sources }
		}
		await reconcileOperationsCatalog(harness.repositories, await snapshot(1, ['app-a']))
		now += MINUTE
		// A snapshot without it disables every Control source it no longer names, and nothing else.
		await reconcileOperationsCatalog(harness.repositories, await snapshot(2, []))
		const sources = await harness.repositories.sources.list()
		expect(sources.map((source) => [source.origin, source.enabled])).toEqual([['control', 0], ['installation', 1]])
		expect(sources.find((source) => source.origin === 'installation')).toEqual(installation ?? undefined)
		expect(await harness.repositories.sources.getByCoordinate(INSTALLATION_SOURCE.appId, INSTALLATION_SOURCE.environment, 'default')).toBeNull()
	})
})
