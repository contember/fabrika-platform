import { createGitHubAppViaManifest, type GitHubAppManifestInput, type GitHubAppManifestRuntime } from '@fabrika/installation-init'
import { expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openEnvFile, parseEnvFile, persistEnvBundle } from '../envfile'
import { ensureGitHubApp } from '../init'

const app = {
	id: 123,
	slug: 'fabrika-test',
	htmlUrl: 'https://github.com/apps/fabrika-test',
	pem: '-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----',
	webhookSecret: 'generated-webhook-secret',
}
const bundle = {
	GITHUB_APP_PRIVATE_KEY: app.pem,
	GITHUB_WEBHOOK_SECRET: app.webhookSecret,
	GITHUB_APP_ID: String(app.id),
	GITHUB_APP_SLUG: app.slug,
	GITHUB_APP_URL: app.htmlUrl,
}
const context = {
	account: 'test-account',
	controlPlaneDomain: 'control.example.test',
	githubOrg: 'acme',
	installRepos: ['acme/app'],
}
const configHomeKey = 'XDG_CONFIG_HOME'

test.each(['saved', 'failed'])('Cloudflare loopback acknowledgement waits for credential custody: %s', async (outcome) => {
	const configHome = await mkdtemp(join(tmpdir(), 'fabrika-cloudflare-custody-'))
	const previousConfigHome = process.env[configHomeKey]
	const previousBundle = Object.fromEntries(Object.keys(bundle).map((key) => [key, process.env[key]]))
	const output: string[] = []
	const stdout = spyOn(console, 'log').mockImplementation((...values) => {
		output.push(values.map((value) => String(value)).join(' '))
	})
	let resolveUrl: (value: string) => void = () => {
		throw new Error('loopback URL latch was not initialized')
	}
	const urlPromise = new Promise<string>((resolve) => {
		resolveUrl = resolve
	})
	let releasePersistence = (): void => {
		throw new Error('persistence latch was not initialized')
	}
	const persistence = new Promise<void>((resolve) => {
		releasePersistence = resolve
	})
	let markPersistenceStarted = (): void => {
		throw new Error('persistence start latch was not initialized')
	}
	const persistenceStarted = new Promise<void>((resolve) => {
		markPersistenceStarted = resolve
	})
	let callbackFinished = false
	let creationFinished = false
	let installationActions = 0
	let confirmations = 0
	let creations = 0
	let writes = 0
	let installed: Promise<unknown> | undefined
	let callback: Promise<Response> | undefined
	process.env[configHomeKey] = configHome
	for (const key of Object.keys(bundle)) delete process.env[key]
	try {
		const path = await openEnvFile(context.account)
		expect(path).toBe(join(configHome, 'fabrika', 'cloudflare', context.account, '.env'))
		if (outcome === 'failed') await mkdir(path)
		const dependencies = {
			source: process.env,
			create: (input: GitHubAppManifestInput, runtime?: GitHubAppManifestRuntime) => {
				creations++
				return createGitHubAppViaManifest(input, {
					...runtime,
					fetch: () =>
						Promise.resolve(Response.json({
							id: app.id,
							slug: app.slug,
							html_url: app.htmlUrl,
							pem: app.pem,
							webhook_secret: app.webhookSecret,
						})),
					callbackTimeoutMs: 1_000,
					persistenceTimeoutMs: 1_000,
					onLocalUrl: resolveUrl,
				}).then((created) => {
					creationFinished = true
					return created
				})
			},
			persist: async (values: Readonly<Record<string, string>>) => {
				writes++
				expect(values).toEqual(bundle)
				markPersistenceStarted()
				await persistence
				await persistEnvBundle(values)
			},
			appName: () => Promise.resolve(app.slug),
			confirmInstallation: () => {
				confirmations++
				return Promise.resolve(confirmations > 1)
			},
			installAction: () => {
				installationActions++
			},
		}
		const result = ensureGitHubApp(context, dependencies).then(
			(created) => ({ app: created }),
			(error: unknown) => ({ error }),
		)
		installed = result
		const localUrl = await urlPromise
		const page = await (await fetch(localUrl)).text()
		const state = /settings\/apps\/new\?state=([a-f0-9]+)/.exec(page)?.[1]
		expect(state).toBeDefined()
		callback = fetch(`${localUrl}callback?code=temporary-code&state=${state}`).then(async (response) => {
			callbackFinished = true
			if (response.ok) {
				expect(parseEnvFile(await Bun.file(path).text())).toEqual(bundle)
				expect((await stat(path)).mode & 0o777).toBe(0o600)
				expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
			}
			return response
		})
		await persistenceStarted
		expect(callbackFinished).toBe(false)
		expect(creationFinished).toBe(false)
		expect(installationActions).toBe(0)
		expect(confirmations).toBe(0)
		expect(output.join('\n')).not.toContain('GitHub App created:')
		expect(output.join('\n')).not.toContain('credentials saved')
		for (const key of Object.keys(bundle)) expect(process.env[key]).toBeUndefined()
		releasePersistence()
		const response = await callback
		const responseText = await response.text()
		const settled = await result
		const error = 'error' in settled ? settled.error : undefined
		expect(error).toBeInstanceOf(Error)
		expect(writes).toBe(1)
		if (outcome === 'saved') {
			expect(response.status).toBe(200)
			expect(responseText).toContain('GitHub App created')
			expect(error instanceof Error ? error.message : '').toContain('GitHub App installation is required')
			for (const key of Object.keys(bundle)) delete process.env[key]
			await openEnvFile(context.account)
			expect(await ensureGitHubApp(context, dependencies)).toEqual(app)
			expect(creations).toBe(1)
			expect(writes).toBe(1)
			expect(confirmations).toBe(2)
			expect(installationActions).toBe(2)
		} else {
			expect(response.status).toBe(400)
			expect(responseText).toContain('GitHub App setup failed')
			expect(responseText).not.toContain('GitHub App created')
			expect(error instanceof Error ? error.message : '').toBe('GitHub App manifest callback failed')
			expect(creationFinished).toBe(false)
			expect(installationActions).toBe(0)
			expect(confirmations).toBe(0)
			expect(output.join('\n')).not.toContain('GitHub App created:')
			expect(output.join('\n')).not.toContain('credentials saved')
			for (const key of Object.keys(bundle)) expect(process.env[key]).toBeUndefined()
		}
		for (const secret of [app.pem, app.webhookSecret]) {
			expect(responseText).not.toContain(secret)
			expect(output.join('\n')).not.toContain(secret)
			expect(error instanceof Error ? error.message : '').not.toContain(secret)
		}
		await expect(fetch(localUrl)).rejects.toThrow()
	} finally {
		releasePersistence()
		await Promise.allSettled([installed, callback])
		stdout.mockRestore()
		if (previousConfigHome === undefined) delete process.env[configHomeKey]
		else process.env[configHomeKey] = previousConfigHome
		for (const [key, value] of Object.entries(previousBundle)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		await rm(configHome, { recursive: true, force: true })
	}
})
