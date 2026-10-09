import { parseProxyManifest } from '@fabrika/proxy-core/manifest'
import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { buildCaddyConfig } from '../caddy'

const directories: string[] = []
afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

test('build-time owner JSON preserves explicit ownership, null disables it, and malformed coordinates fail', async () => {
	const directory = await mkdtemp(resolve(tmpdir(), 'proxy-owner-'))
	directories.push(directory)
	const manifest = {
		apps: [{ id: 'login', hosts: ['iam.example.test'], upstream: 'iam:3000', installation: true, endpoints: [], reservedPrefixes: [] }],
	}
	const manifestPath = resolve(directory, 'manifest.json')
	const output = resolve(directory, 'caddy.json')
	await Bun.write(manifestPath, JSON.stringify(manifest))
	const owner = { issuer: 'https://iam.example.test', upstream: 'iam:3000' }
	const parsedManifest = parseProxyManifest(manifest)
	if (parsedManifest === null) throw new Error('invalid fixture manifest')
	for (const value of [owner, null]) {
		const process = Bun.spawn([Bun.which('bun') ?? 'bun', resolve(import.meta.dir, '../generate-config.ts'), manifestPath, output], {
			env: { ...Bun.env, FABRIKA_PROXY_SESSION_OWNER_JSON: JSON.stringify(value) },
			stdout: 'ignore',
			stderr: 'pipe',
		})
		expect(await process.exited).toBe(0)
		expect(await Bun.file(output).json()).toEqual(buildCaddyConfig(parsedManifest, {
			authUpstream: '127.0.0.1:9000',
			...(value === null ? {} : { iamSessionOwner: value }),
		}))
	}
	for (const value of [{ issuer: owner.issuer }, { ...owner, extra: true }, { ...owner, issuer: 'https://iam.example.test/path' }]) {
		await rm(output)
		const process = Bun.spawn([Bun.which('bun') ?? 'bun', resolve(import.meta.dir, '../generate-config.ts'), manifestPath, output], {
			env: { ...Bun.env, FABRIKA_PROXY_SESSION_OWNER_JSON: JSON.stringify(value) },
			stdout: 'ignore',
			stderr: 'ignore',
		})
		expect(await process.exited).not.toBe(0)
		expect(await Bun.file(output).exists()).toBe(false)
		await Bun.write(output, '')
	}
})
