import { schemaFromContract } from '@fabrika/app/contract'
import { contractDigest } from '@fabrika/auth-core'
import { uuidv7 } from '@fabrika/platform'
import { cloudflareArtifact, cloudflareArtifactCodec, type CloudflareRunnerJob, cloudflareStoredTargetCodec } from '@fabrika/provider-cloudflare'
import { type ProviderDeployInput, type ProviderEnvelope, ProviderInvocationAbort } from '@fabrika/provider-contract'
import type { RelayResult, RunnerStatus } from '@fabrika/runner-cloudflare'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { SourceFailure } from '../github/source/failure'
import { CLOUDFLARE_MAIL_REMEDY } from '../mail-transport'
import {
	cancelRunOnRunner,
	cloudflareControlProvider,
	cloudflareDeployments,
	cloudflareGitHubSource,
	type CloudflareRunnerService,
	controlEnv,
	recoverRunOnRunner,
	startRunOnRunner,
	type WorkerBindings,
} from '../platform-cf'
import { buildRunDeps } from '../services'
import { createHarness } from './helpers/harness'

const envelope = <T>(codec: { version: number; encode(value: T): ProviderEnvelope['payload'] }, value: T): ProviderEnvelope => ({
	provider: 'cloudflare',
	version: codec.version,
	payload: codec.encode(value),
})

const deployInput = (): ProviderDeployInput => ({
	runId: 'run-1',
	app: {
		id: 'api',
		source: {
			repoUrl: 'https://github.com/example/api.git',
			ref: 'abcdef1234567890abcdef1234567890abcdef12',
		},
	},
	environment: {
		appId: 'api',
		env: 'production',
		domain: 'api.example.com',
		publicOrigin: 'https://public.example.com',
		target: envelope(cloudflareStoredTargetCodec, { stateNamespace: 'api-state' }),
		artifact: envelope(cloudflareArtifactCodec, cloudflareArtifact('deploy.config.ts')),
		access: { contract: notesArtifact, contractDigest: contractDigest(notesArtifact), schema: schemaFromContract(notesArtifact), checker: '0.7.0' },
	},
	secrets: {},
	vars: {},
	managedEnvironment: {},
	dryRun: false,
	signal: new AbortController().signal,
	events: {
		log: () => {},
		externalId: async () => {},
		checkpoint: async () => {},
		boundary: async () => {},
	},
})

function workerBindings(harness: ReturnType<typeof createHarness>): WorkerBindings {
	const unexpected = (): never => {
		throw new Error('unexpected binding access')
	}
	return {
		ENVIRONMENT: 'stage',
		DB: harness.d1,
		ASSETS: { fetch: unexpected, connect: unexpected },
		RUN_LOGS: {
			head: unexpected,
			get: unexpected,
			put: unexpected,
			createMultipartUpload: unexpected,
			resumeMultipartUpload: unexpected,
			delete: unexpected,
			list: unexpected,
		},
		DEPLOY_QUEUE: { send: unexpected, sendBatch: unexpected, metrics: unexpected },
		FABRIKA_RUNNER_KEY: 'test-runner-key',
		CLOUDFLARE_ACCOUNT_ID: 'account',
		CLOUDFLARE_API_TOKEN: 'token',
	}
}

describe("the Cloudflare composition's mail transport", () => {
	test("reads the installation's FABRIKA_EMAIL_* from the Worker's vars and secrets, and hands it to every deploy", async () => {
		const harness = createHarness()
		try {
			// The provider's own variables are Worker secrets the bindings type does not name: an open registry owns them.
			const providerSecrets = {
				FABRIKA_EMAIL_RESEND_API_KEY: 're_key',
				// A provider no longer selected leaves its secret on the Worker; it is never handed on.
				FABRIKA_EMAIL_POSTMARK_SERVER_TOKEN: 'pm_stale',
			}
			const sender = { FABRIKA_EMAIL_PROVIDER: 'resend', FABRIKA_EMAIL_FROM: 'mail@example.test', FABRIKA_EMAIL_FROM_NAME: 'Fabrika' }
			const bindings: WorkerBindings = { ...workerBindings(harness), ...sender, ...providerSecrets }
			const env = controlEnv(bindings, () => {})
			const deps = await buildRunDeps(env, cloudflareControlProvider(bindings, env))
			expect(deps.mailTransport).toEqual({
				kind: 'transport',
				transport: {
					variables: {
						FABRIKA_EMAIL_PROVIDER: 'resend',
						FABRIKA_EMAIL_FROM: 'mail@example.test',
						FABRIKA_EMAIL_FROM_NAME: 'Fabrika',
						FABRIKA_EMAIL_RESEND_API_KEY: 're_key',
					},
					secretNames: new Set(['FABRIKA_EMAIL_RESEND_API_KEY']),
				},
			})
		} finally {
			harness.sqlite.close()
		}
	})

	test('no provider, or an empty one, is none; an invalid set names the variables and keeps the Worker serving', () => {
		const harness = createHarness()
		try {
			expect(controlEnv(workerBindings(harness), () => {}).MAIL_TRANSPORT).toEqual({ kind: 'none' })
			const empty = { FABRIKA_EMAIL_PROVIDER: '' }
			expect(controlEnv({ ...workerBindings(harness), ...empty }, () => {}).MAIL_TRANSPORT).toEqual({ kind: 'none' })
			const keyWithoutSender = { FABRIKA_EMAIL_PROVIDER: 'resend', FABRIKA_EMAIL_RESEND_API_KEY: 're_private' }
			const bindings: WorkerBindings = { ...workerBindings(harness), ...keyWithoutSender }
			const invalid = controlEnv(bindings, () => {})
			// Parsed once per bindings object, not on every fetch, queue batch or cron tick.
			expect(controlEnv(bindings, () => {}).MAIL_TRANSPORT).toBe(invalid.MAIL_TRANSPORT)
			expect(invalid.MAIL_TRANSPORT).toEqual({
				kind: 'invalid',
				reason: expect.stringContaining('FABRIKA_EMAIL_FROM is missing'),
				remedy: CLOUDFLARE_MAIL_REMEDY,
			})
			expect(JSON.stringify(invalid.MAIL_TRANSPORT)).not.toContain('re_private')
		} finally {
			harness.sqlite.close()
		}
	})
})

describe("the Cloudflare composition's registry", () => {
	test('lists every Cloudflare deployment, and no deployment of another provider', async () => {
		const harness = createHarness()
		try {
			const registry = harness.repositories.registry
			const deployments = [['api', 'production', 'cloudflare'], ['api', 'stage', 'cloudflare'], ['notes', 'prod', 'cloudflare'], [
				'shop',
				'prod',
				'zerops',
			]]
			for (const [appId = '', env = '', provider = ''] of deployments) {
				if ((await registry.getApp(appId)) === null) await registry.createApp({ id: appId, repoUrl: `github.com/example/${appId}` })
				await registry.upsertAppEnv({ appId, env, namespaceId: null, provider, providerTargetJson: '{}', providerArtifactJson: '{}' })
			}
			expect(await cloudflareDeployments(harness.repositories)).toEqual([
				{ app: 'api', env: 'production' },
				{ app: 'api', env: 'stage' },
				{ app: 'notes', env: 'prod' },
			])
		} finally {
			harness.sqlite.close()
		}
	})
})

describe('the Cloudflare source composition', () => {
	test('resolves the recorded commit or requested ref anonymously; a missing runner binding refuses acceptance', async () => {
		const harness = createHarness()
		const effects: string[] = []
		const requests: string[] = []
		const input = deployInput()
		const bindings = workerBindings(harness)
		const seams = {
			metadataFetch: async (url: string | URL | Request, init?: RequestInit) => {
				requests.push(`${String(url)} ${new Headers(init?.headers).has('authorization')}`)
				return Response.json({ sha: input.app.source.ref })
			},
		}
		try {
			const provider = cloudflareControlProvider(bindings, controlEnv(bindings, () => {}), seams)
			if (provider.resolveSource === undefined) throw new Error('missing resolver')
			const source = { ...input.app.source, repoUrl: 'github.com/example/api', ref: 'refs/heads/main' }
			const selection = { ...input, app: { ...input.app, source }, expectedCommitSha: input.app.source.ref }
			expect(await provider.resolveSource(selection)).toEqual({ commitSha: input.app.source.ref })
			const { expectedCommitSha: _recorded, ...unrecorded } = selection
			await provider.resolveSource(unrecorded)
			expect(requests).toEqual([
				`https://api.github.com/repos/example/api/commits/${input.app.source.ref} false`,
				'https://api.github.com/repos/example/api/commits/refs%2Fheads%2Fmain false',
			])
			await expect(provider.deploy({
				...input,
				app: { ...input.app, source: { ...source, ref: input.app.source.ref } },
				events: {
					...input.events,
					externalId: async () => {
						effects.push('accepted')
					},
				},
			})).rejects.toThrow('Cloudflare provider requires the RUNNER_SVC service binding')
			expect(effects).toEqual([])
		} finally {
			harness.sqlite.close()
		}
	})

	test('a public clone is the bare canonical URL and needs no vault', async () => {
		const harness = createHarness()
		const source = cloudflareGitHubSource(controlEnv(workerBindings(harness), () => {}))
		const signal = new AbortController().signal
		expect(await source.prepareClone({ repoUrl: 'github.com/acme/public', ref: 'refs/heads/main' }, signal)).toEqual({
			repoUrl: 'https://github.com/acme/public',
		})
		expect((await source.prepareClone({ repoUrl: 'github.com/acme/public.git', ref: 'refs/tags/v1' }, signal)).repoUrl).toBe(
			'https://github.com/acme/public',
		)
		harness.sqlite.close()
	})

	test('refuses caller-controlled repositories before any request', async () => {
		const harness = createHarness()
		let requests = 0
		const counted = () => {
			requests += 1
			return Promise.reject(new Error('must not be called'))
		}
		const source = cloudflareGitHubSource(controlEnv(workerBindings(harness), () => {}), { metadataFetch: counted, githubAppFetch: counted })
		const signal = new AbortController().signal
		for (
			const repoUrl of [
				'https://evil.example/acme/repo',
				'https://github.com/acme/repo',
				'http://github.com/acme/repo',
				'github.com@evil.example/acme/repo',
				'github.com/acme/repo?next=evil',
				'github.com/acme/repo#fragment',
				'github.com/acme/repo/extra',
			]
		) {
			await expect(source.prepareClone({ repoUrl, ref: 'refs/heads/main' }, signal, { connectionId: 'c', installationId: 7 })).rejects.toThrow(
				'invalid canonical GitHub repository',
			)
		}
		expect(requests).toBe(0)
		harness.sqlite.close()
	})

	test('preserves pre-aborted and in-flight deployment reasons through resolution', async () => {
		const harness = createHarness()
		let requests = 0
		const started = Promise.withResolvers<void>()
		const source = cloudflareGitHubSource(controlEnv(workerBindings(harness), () => {}), {
			metadataFetch: (_url, init) => {
				requests += 1
				started.resolve()
				const signal = init?.signal
				if (!(signal instanceof AbortSignal)) throw new Error('expected caller-linked signal')
				return new Promise<Response>((_resolve, reject) => {
					signal.addEventListener('abort', () => reject(new Error('private reason')), { once: true })
				})
			},
		})
		const input = deployInput()
		const app = { ...input.app, source: { ...input.app.source, repoUrl: 'github.com/acme/private', ref: 'refs/heads/main' } }

		const preAborted = new AbortController()
		const firstReason = new ProviderInvocationAbort('lease_lost')
		preAborted.abort(firstReason)
		expect(await source.resolveSource({ ...input, app, signal: preAborted.signal }).catch((error: unknown) => error)).toBe(firstReason)
		expect(requests).toBe(0)

		const inFlight = new AbortController()
		const pending = source.resolveSource({ ...input, app, signal: inFlight.signal })
		await started.promise
		const secondReason = new ProviderInvocationAbort('cancel_requested')
		inFlight.abort(secondReason)
		expect(await pending.catch((error: unknown) => error)).toBe(secondReason)
		expect(requests).toBe(1)
		harness.sqlite.close()
	})

	test('a webhook or poll run of a branch fails before the provider when the branch moved past the pushed commit', async () => {
		const harness = createHarness()
		const pushed = 'a'.repeat(40)
		const moved = 'b'.repeat(40)
		const requests: string[] = []
		const source = cloudflareGitHubSource(controlEnv(workerBindings(harness), () => {}), {
			metadataFetch: (url) => {
				requests.push(String(url))
				return Promise.resolve(Response.json({ sha: String(url).endsWith(pushed) ? pushed : moved }))
			},
		})
		await harness.db.registry.createApp({ id: 'api', repoUrl: 'github.com/acme/public' })
		const resolve = async (trigger: 'webhook' | 'poll' | 'manual', ref: string) => {
			const runId = uuidv7()
			await harness.db.runs.createRun({ id: runId, appId: 'api', env: 'production', ref, commitSha: pushed, trigger, actor: trigger })
			const input = deployInput()
			const app = { ...input.app, source: { ...input.app.source, repoUrl: 'github.com/acme/public', ref } }
			return source.resolveSource({ ...input, runId, app, expectedCommitSha: pushed })
		}
		try {
			const moving: Array<'webhook' | 'poll'> = ['webhook', 'poll']
			for (const trigger of moving) {
				const refused = await resolve(trigger, 'refs/heads/main').catch((error: unknown) => error)
				expect(refused).toBeInstanceOf(SourceFailure)
				expect(refused).toMatchObject({ code: 'commit_mismatch', stage: 'resolve' })
			}
			// A manual run pinned to a commit, and a tag, deploy the recorded commit wherever the ref points now.
			expect(await resolve('manual', 'refs/heads/main')).toEqual({ commitSha: pushed })
			expect(await resolve('webhook', 'refs/tags/v1')).toEqual({ commitSha: pushed })
			expect(requests).toEqual([
				'https://api.github.com/repos/acme/public/commits/refs%2Fheads%2Fmain',
				'https://api.github.com/repos/acme/public/commits/refs%2Fheads%2Fmain',
				`https://api.github.com/repos/acme/public/commits/${pushed}`,
				`https://api.github.com/repos/acme/public/commits/${pushed}`,
			])
		} finally {
			harness.sqlite.close()
		}
	})
})

// The runner port. vozka-runner refuses any RPC that does not present FABRIKA_RUNNER_KEY, so both
// directions are pinned here: the key control sends on a cancel, and the terminal outcome it reads
// back — the executor's compiled IAM reconcile rides on the status, because core, not the untrusted
// container, is what applies it with the IAM admin key.

interface RunnerCall {
	readonly method: 'startRun' | 'cancelRun' | 'recoverRun'
	readonly runId: string
	readonly runnerKey: string | undefined
}

function fakeRunner(calls: RunnerCall[], result: RelayResult, persisted: RunnerStatus | null = null): CloudflareRunnerService {
	return {
		startRun: async (job) => {
			calls.push({ method: 'startRun', runId: job.runId, runnerKey: job.runnerKey })
			return result
		},
		cancelRun: async (runId, runnerKey) => {
			calls.push({ method: 'cancelRun', runId, runnerKey })
		},
		recoverRun: async (runId, runnerKey) => {
			calls.push({ method: 'recoverRun', runId, runnerKey })
			return persisted
		},
	}
}

const job = (): CloudflareRunnerJob => ({
	runId: 'run-1',
	repoUrl: 'https://github.com/example/api.git',
	ref: 'abcdef1234567890abcdef1234567890abcdef12',
	env: 'production',
	runnerKey: 'test-runner-key',
	credentials: { CLOUDFLARE_ACCOUNT_ID: 'account-1', CLOUDFLARE_API_TOKEN: 'token-1' },
})

describe('the Cloudflare runner port', () => {
	test("the executor's IAM reconcile rides back on the terminal outcome", async () => {
		const calls: RunnerCall[] = []
		const result: RelayResult = {
			lineCount: 3,
			status: {
				runId: 'run-1',
				state: 'succeeded',
				exitCode: 0,
				artifactState: 'complete',
				iamReconcile: { app: 'api', schemaJson: '{"actions":[]}' },
				startedAt: 1,
				finishedAt: 9,
			},
		}

		const outcome = await startRunOnRunner(fakeRunner(calls, result), job())

		expect(outcome).toEqual({
			state: 'succeeded',
			exitCode: 0,
			artifactState: 'complete',
			iamReconcile: { app: 'api', schemaJson: '{"actions":[]}' },
		})
		expect(calls).toEqual([{ method: 'startRun', runId: 'run-1', runnerKey: 'test-runner-key' }])
	})

	test('a run that never reached the reconcile step leaves the field absent, not empty', async () => {
		const result: RelayResult = { lineCount: 1, status: { runId: 'run-1', state: 'failed', exitCode: 1, startedAt: 1 } }

		expect(await startRunOnRunner(fakeRunner([], result), job())).toEqual({ state: 'failed', exitCode: 1 })
	})

	test('a cancel presents the runner key', async () => {
		const calls: RunnerCall[] = []
		const runner = fakeRunner(calls, { lineCount: 0, status: { runId: 'run-1', state: 'failed', startedAt: 1 } })

		await cancelRunOnRunner(runner, 'run-1', 'test-runner-key')

		expect(calls).toEqual([{ method: 'cancelRun', runId: 'run-1', runnerKey: 'test-runner-key' }])
	})

	test('a cancel with no configured key never reaches the runner', async () => {
		const calls: RunnerCall[] = []
		const runner = fakeRunner(calls, { lineCount: 0, status: { runId: 'run-1', state: 'failed', startedAt: 1 } })

		await expect(cancelRunOnRunner(runner, 'run-1', undefined)).rejects.toThrow('FABRIKA_RUNNER_KEY')
		await expect(cancelRunOnRunner(runner, 'run-1', '')).rejects.toThrow('FABRIKA_RUNNER_KEY')
		expect(calls).toEqual([])
	})

	test('recovery reads the persisted terminal status as the outcome, IAM reconcile included', async () => {
		const calls: RunnerCall[] = []
		const persisted: RunnerStatus = {
			runId: 'run-1',
			state: 'succeeded',
			exitCode: 0,
			iamReconcile: { app: 'api', schemaJson: '{"actions":[]}' },
			startedAt: 1,
			finishedAt: 9,
		}
		const runner = fakeRunner(calls, { lineCount: 0, status: persisted }, persisted)

		expect(await recoverRunOnRunner(runner, 'run-1', 'test-runner-key')).toEqual({
			state: 'succeeded',
			exitCode: 0,
			iamReconcile: { app: 'api', schemaJson: '{"actions":[]}' },
		})
		expect(calls).toEqual([{ method: 'recoverRun', runId: 'run-1', runnerKey: 'test-runner-key' }])
	})

	test('runner results are parsed at the boundary: an old or malformed answer throws rather than failing the run', async () => {
		const wire = <T>(json: string): T => {
			const box: { v: T } = JSON.parse(`{"v":${json}}`)
			return box.v
		}
		const runner = (recovered: RunnerStatus | null, started: RelayResult): CloudflareRunnerService => ({
			startRun: async () => started,
			cancelRun: async () => {},
			recoverRun: async () => recovered,
		})
		const terminal: RelayResult = { lineCount: 0, status: { runId: 'run-1', state: 'succeeded', startedAt: 1 } }

		await expect(recoverRunOnRunner(runner(wire('"running"'), terminal), 'run-1', 'test-runner-key')).rejects.toThrow('malformed recovery status')
		await expect(recoverRunOnRunner(runner(wire('{"runId":"run-1","state":"done","startedAt":1}'), terminal), 'run-1', 'test-runner-key')).rejects
			.toThrow('malformed recovery status')
		expect(await recoverRunOnRunner(runner({ runId: 'run-1', state: 'deploying', startedAt: 1 }, terminal), 'run-1', 'test-runner-key')).toEqual({
			state: 'running',
		})
		expect(await recoverRunOnRunner(runner({ runId: 'run-1', state: 'failed', dryRun: true, startedAt: 1 }, terminal), 'run-1', 'test-runner-key'))
			.toEqual({ state: 'failed', dryRun: true })

		await expect(startRunOnRunner(runner(null, wire('{"status":"succeeded"}')), job())).rejects.toThrow('malformed run result')
		await expect(startRunOnRunner(runner(null, { lineCount: 0, status: { runId: 'run-1', state: 'deploying', startedAt: 1 } }), job())).rejects
			.toThrow('non-terminal run result')
	})

	test('recovery reports a run with no persisted status as still running, and needs the key', async () => {
		const calls: RunnerCall[] = []
		const runner = fakeRunner(calls, { lineCount: 0, status: { runId: 'run-1', state: 'failed', startedAt: 1 } })

		await expect(recoverRunOnRunner(runner, 'run-1', undefined)).rejects.toThrow('FABRIKA_RUNNER_KEY')
		expect(await recoverRunOnRunner(runner, 'run-1', 'test-runner-key')).toEqual({ state: 'running' })
		expect(calls).toEqual([{ method: 'recoverRun', runId: 'run-1', runnerKey: 'test-runner-key' }])
	})
})
