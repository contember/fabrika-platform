// `managedCredentials.write`: Control's write of a re-issued key to the application Worker without a deploy. One new
// version of the Worker the platform proxy binds as `APP`, with the named secrets replaced and every other binding
// inherited; the account token goes only to Cloudflare's API, no redirect is followed, and a Worker outside the
// environment's names is never written.

import type { ProviderEnvironment } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { cloudflareArtifact, cloudflareArtifactCodec, cloudflareStoredTargetCodec, createCloudflareControlProvider } from '..'

const TOKEN = 'cf-account-token-of-the-suite'
const API = 'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts'

const environment: ProviderEnvironment = {
	appId: 'notes',
	env: 'prod',
	target: { provider: 'cloudflare', version: cloudflareStoredTargetCodec.version, payload: cloudflareStoredTargetCodec.encode({}) },
	artifact: {
		provider: 'cloudflare',
		version: cloudflareArtifactCodec.version,
		payload: cloudflareArtifactCodec.encode(cloudflareArtifact('fabrika.config.ts')),
	},
}

interface Sent {
	readonly method: string
	readonly url: string
	readonly authorization: string | null
	readonly redirect: RequestRedirect | undefined
	readonly settings: unknown
}

/**
 * Cloudflare's API over the proxy's and the application's settings; `answer` overrides one URL's response, and
 * `nullErrors` answers each success with `"errors": null`, as some endpoints do.
 */
function cloudflare(options: { app?: string; answer?: (url: string, method: string) => Response | null; nullErrors?: boolean } = {}) {
	const sent: Sent[] = []
	const settings: Record<string, unknown> = {
		[`${API}/${options.app ?? 'prod-notes'}/settings`]: {
			bindings: [
				{ type: 'secret_text', name: 'FABRIKA_JOB_PURGE_DELETED_KEY' },
				{ type: 'secret_text', name: 'FABRIKA_PROXY_SECRET' },
				{ type: 'plain_text', name: 'FABRIKA_RELEASE', text: 'r1' },
				{ type: 'durable_object_namespace', name: 'FABRIKA_APPLICATION', class_name: 'FabrikaApplication' },
			],
		},
		// Last, so a proxy that names itself keeps its own settings.
		[`${API}/prod-notes-proxy/settings`]: {
			bindings: [{ type: 'service', name: 'APP', service: options.app ?? 'prod-notes' }, { type: 'service', name: 'IAM', service: 'prod-iam' }],
		},
	}
	const fetch = async (url: string, init: RequestInit): Promise<Response> => {
		const method = init.method ?? 'GET'
		const body = init.body instanceof FormData ? init.body.get('settings') : null
		sent.push({
			method,
			url,
			authorization: new Headers(init.headers).get('authorization'),
			redirect: init.redirect,
			settings: typeof body === 'string' ? JSON.parse(body) : null,
		})
		const answered = options.answer?.(url, method) ?? null
		if (answered !== null) return answered
		const errors = options.nullErrors === true ? null : []
		if (method === 'PATCH') return Response.json({ success: true, result: {}, errors })
		const result = settings[url]
		return result === undefined
			? Response.json({ success: false, result: null, errors: [{ code: 10007, message: 'This Worker does not exist on your account.' }] }, {
				status: 404,
			})
			: Response.json({ success: true, result, errors })
	}
	const provider = createCloudflareControlProvider({
		accountId: 'account-1',
		apiToken: TOKEN,
		runnerKey: 'runner-key',
		resolveSource: async () => ({ commitSha: 'a'.repeat(40) }),
		prepareClone: async (source) => ({ repoUrl: source.repoUrl }),
		startRun: async () => ({ state: 'succeeded' }),
		cancelRun: async () => {},
		cloudflareFetch: fetch,
	})
	const write = (values: Record<string, string>, target: ProviderEnvironment = environment) => {
		if (provider.managedCredentials === undefined) throw new Error('the Cloudflare provider writes managed credentials')
		return provider.managedCredentials.write({ environment: target, values, signal: new AbortController().signal })
	}
	return { sent, write }
}

describe('writing managed credentials to an application Worker without a deploy', () => {
	test('writes the secrets in one new version of the Worker its proxy binds, every other binding inherited', async () => {
		const api = cloudflare()
		await api.write({ FABRIKA_JOB_PURGE_DELETED_KEY: 'px_new_job_key', FABRIKA_WEBHOOK_GITHUB_KEY: 'px_new_webhook_key' })
		expect(api.sent.map((sent) => `${sent.method} ${sent.url}`)).toEqual([
			`GET ${API}/prod-notes-proxy/settings`,
			`GET ${API}/prod-notes/settings`,
			`PATCH ${API}/prod-notes/settings`,
		])
		for (const sent of api.sent) {
			expect(sent.authorization).toBe(`Bearer ${TOKEN}`)
			expect(sent.redirect).toBe('manual')
		}
		expect(api.sent[2]?.settings).toEqual({
			bindings: [
				{ type: 'secret_text', name: 'FABRIKA_PROXY_SECRET' },
				{ type: 'plain_text', name: 'FABRIKA_RELEASE' },
				{ type: 'durable_object_namespace', name: 'FABRIKA_APPLICATION' },
				{ type: 'secret_text', name: 'FABRIKA_JOB_PURGE_DELETED_KEY', text: 'px_new_job_key' },
				{ type: 'secret_text', name: 'FABRIKA_WEBHOOK_GITHUB_KEY', text: 'px_new_webhook_key' },
			],
		})
	})

	test('reads a success whose `errors` is null, as Cloudflare answers on some endpoints', async () => {
		const api = cloudflare({ nullErrors: true })
		await api.write({ FABRIKA_JOB_PURGE_DELETED_KEY: 'px_new_job_key' })
		expect(api.sent.map((sent) => sent.method)).toEqual(['GET', 'GET', 'PATCH'])
	})

	test("never writes a Worker outside the environment's names, nor the proxy itself", async () => {
		for (const app of ['prod-other', 'prod-notes-proxy', 'stage-notes']) {
			const api = cloudflare({ app })
			await expect(api.write({ FABRIKA_JOB_PURGE_DELETED_KEY: 'px_new_job_key' })).rejects.toThrow(
				'cloudflare: the proxy Worker prod-notes-proxy binds APP to a Worker outside prod-notes; deploy the environment',
			)
			expect(api.sent.map((sent) => sent.method)).toEqual(['GET'])
		}
		const own = cloudflare({ app: 'prod-notes-worker' })
		await own.write({ FABRIKA_JOB_PURGE_DELETED_KEY: 'px_new_job_key' })
		expect(own.sent.at(-1)?.url).toBe(`${API}/prod-notes-worker/settings`)
	})

	test("a refusal names Cloudflare's reason and the secrets, never a value or the token; a redirect is not followed", async () => {
		const refused = cloudflare({
			answer: (_url, method) =>
				method === 'PATCH'
					? Response.json({ success: false, result: null, errors: [{ code: 10215, message: 'latest version not deployed' }] }, { status: 400 })
					: null,
		})
		const failure = await refused.write({ FABRIKA_JOB_PURGE_DELETED_KEY: 'px_new_job_key' }).then(() => null, (error: unknown) => error)
		expect(failure).toBeInstanceOf(Error)
		const message = failure instanceof Error ? failure.message : ''
		expect(message).toBe('cloudflare: writing the secrets FABRIKA_JOB_PURGE_DELETED_KEY of prod-notes failed: 10215 latest version not deployed')
		expect(message).not.toContain('px_')
		expect(message).not.toContain(TOKEN)

		const redirected = cloudflare({ answer: () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } }) })
		await expect(redirected.write({ FABRIKA_JOB_PURGE_DELETED_KEY: 'px_new_job_key' })).rejects.toThrow(
			'cloudflare: reading the settings of prod-notes-proxy: unexpected response (HTTP 302)',
		)
		expect(redirected.sent).toHaveLength(1)
	})

	test('refuses a dev environment and writes nothing for no values', async () => {
		const api = cloudflare()
		await expect(api.write({ FABRIKA_JOB_PURGE_DELETED_KEY: 'px_new_job_key' }, { ...environment, kind: 'dev' })).rejects.toThrow(
			'Cloudflare runs no dev environment',
		)
		await api.write({})
		expect(api.sent).toEqual([])
	})
})
