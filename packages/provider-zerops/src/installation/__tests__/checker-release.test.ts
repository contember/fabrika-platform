import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FABRIKA_CHECK_VERSION } from '../../execution'
import { assertCheckerPublished, npmCheckerPublication, type RegistryFetch } from '../checker-release'
import { deployPlatform, type PlatformDeployCollaborators } from '../deploy'
import { runInstall } from '../install'
import { recordingInitLog } from '../log'
import { fakePlatformSource, fakeSourceCollaborators } from './fake-platform-source'
import { fakeZerops, platformServices, SUBDOMAINS } from './fake-zerops'

const signal = new AbortController().signal

const answering = (status: number, requested: string[] = []): RegistryFetch => async (url) => {
	requested.push(url)
	return new Response('{}', { status })
}

describe('the npm registry answers whether a checker version is published', () => {
	test('asks for the exact version of @fabrika/check', async () => {
		const requested: string[] = []
		expect(await npmCheckerPublication(answering(200, requested))('0.4.3', signal)).toBe(true)
		expect(requested).toEqual(['https://registry.npmjs.org/@fabrika%2Fcheck/0.4.3'])
	})

	test('reads a 404 as not published', async () => {
		expect(await npmCheckerPublication(answering(404))('0.0.4', signal)).toBe(false)
	})

	test('refuses to guess when npm answers anything else or cannot be reached', async () => {
		await expect(npmCheckerPublication(answering(503))('0.4.3', signal)).rejects.toThrow('npm answered 503 for @fabrika/check@0.4.3')
		const unreachable: RegistryFetch = async () => {
			throw new Error('ECONNRESET')
		}
		await expect(npmCheckerPublication(unreachable)('0.4.3', signal)).rejects.toThrow('could not reach npm')
	})
})

describe('a checkout whose checker npm does not have', () => {
	test('is refused with its version and what to deploy instead', async () => {
		await expect(assertCheckerPublished(async () => false, signal, '0.4.3')).rejects.toThrow(
			'this checkout is version 0.4.3, which is not published yet: npm has no @fabrika/check@0.4.3',
		)
		await expect(assertCheckerPublished(async () => false, signal, '0.4.3')).rejects.toThrow('Deploy a released tag')
	})

	test("is checked at this checkout's own version, the one every application build fetches", async () => {
		const asked: string[] = []
		await assertCheckerPublished(async (version) => {
			asked.push(version)
			return true
		}, signal)
		expect(asked).toEqual([FABRIKA_CHECK_VERSION])
	})

	const unpublished = () => {
		const zerops = fakeZerops({ projectId: 'project', projectName: 'test', services: platformServices({ proxy: { zeropsSubdomain: SUBDOMAINS } }) })
		let disposed = 0
		const collaborators: PlatformDeployCollaborators = {
			...fakeSourceCollaborators,
			prepareSource: async () => ({
				...fakePlatformSource(),
				dispose: async () => {
					disposed++
				},
			}),
			checkerPublished: async () => false,
			api: zerops.api,
			reconcileSchema: async () => {},
			sleep: async () => {},
			log: recordingInitLog(),
			signal,
		}
		return { zerops, collaborators, disposed: () => disposed }
	}

	test('stops platform deploy before it reads or writes anything on Zerops', async () => {
		const { zerops, collaborators, disposed } = unpublished()
		await expect(deployPlatform({
			project: { kind: 'id', projectId: 'project' },
			accessToken: 'token',
			environment: 'stage',
			scheme: 'https',
			iamAdminKey: 'px_key',
			sourceDir: '.',
			dryRun: false,
		}, collaborators)).rejects.toThrow('which is not published yet')
		expect(zerops.calls).toEqual([])
		expect(disposed()).toBe(1)
	})

	test('stops platform install before it creates a project or asks anything', async () => {
		const { zerops, collaborators, disposed } = unpublished()
		const asked: string[] = []
		await expect(runInstall({
			project: { kind: 'create', projectName: 'new' },
			clientId: 'client',
			accessToken: 'token',
			environment: 'stage',
			scheme: 'https',
			sourceDir: '.',
			secretsFile: join(tmpdir(), `fabrika-install-test-${crypto.randomUUID()}.env`),
			tier: 'light',
			unattended: true,
		}, {
			...collaborators,
			log: recordingInitLog(),
			prompts: {
				confirm: async (question) => {
					asked.push(question)
					return true
				},
			},
			storeSecrets: async () => {},
		})).rejects.toThrow('which is not published yet')
		expect(zerops.calls).toEqual([])
		expect(asked).toEqual([])
		expect(disposed()).toBe(1)
	})
})
