import { describe, expect, spyOn, test } from 'bun:test'
import { tmpdir } from 'node:os'
import {
	decodeZeropsNamespaceProxySource,
	prepareZeropsDescriptor,
	verifyZeropsNamespaceProxySource,
	ZeropsApiError,
	type ZeropsAppVersionStatus,
} from '../../index'
import { deployPlatform, deployPlatformService, type PlatformDeployCollaborators } from '../deploy'
import { parsePlatformDeployArgs } from '../deploy-options'
import { type InstallCollaborators, runInstall } from '../install'
import { parsePlatformInstallArgs } from '../install-options'
import { prepareInstallationSource } from '../installation-source'
import { recordingInitLog } from '../log'
import { uploadPlatformArchive, validatePlatformUploadUrl } from '../platform-upload'
import { fakeNamespaceProxySource, fakePlatformSource, fakeSourceCollaborators } from './fake-platform-source'
import { fakeZerops, importedLightServices, platformServices, SUBDOMAINS } from './fake-zerops'

const deployInput = {
	project: { kind: 'id', projectId: 'project' },
	accessToken: 'token',
	environment: 'stage',
	scheme: 'https',
	iamAdminKey: 'px_key',
	sourceDir: '.',
	dryRun: false,
} satisfies Parameters<typeof deployPlatform>[0]

const fixture = () => {
	const zerops = fakeZerops({ projectId: 'project', projectName: 'test', services: platformServices({ proxy: { zeropsSubdomain: SUBDOMAINS } }) })
	const collaborators: PlatformDeployCollaborators = {
		...fakeSourceCollaborators,
		api: zerops.api,
		reconcileSchema: async () => {},
		sleep: async () => {},
		log: recordingInitLog(),
		signal: new AbortController().signal,
	}
	return { zerops, collaborators }
}

describe('exact installation source', () => {
	for (const parse of [parsePlatformDeployArgs, parsePlatformInstallArgs]) {
		test(`${parse.name} requires explicit source and refuses mutable installation sources`, () => {
			expect(() => parse([], {})).toThrow('--source-dir')
			expect(() => parse(['--source-dir=.', '--from-git=https://example.com'], {})).toThrow('Mutable installation Git sources are refused')
			expect(() => parse(['--source-dir=.'], { FABRIKA_ZEROPS_BUILD_FROM_GIT: '' })).toThrow('unset FABRIKA_ZEROPS_BUILD_FROM_GIT')
		})
	}

	test('a different checkout cannot supply the executing module and manifest', async () => {
		await expect(prepareInstallationSource(tmpdir(), new AbortController().signal)).rejects.toThrow('run bun packages/cli/src/index.ts')
	})

	for (const invalid of ['prepare', 'setup']) {
		test(`${invalid} failure precedes every deploy mutation`, async () => {
			const { zerops, collaborators } = fixture()
			let disposed = false
			const source = fakePlatformSource()
			source.descriptor = { ...source.descriptor, contents: 'zerops:\n  - setup: proxy\n' }
			source.dispose = async () => {
				disposed = true
			}
			await expect(deployPlatform(deployInput, {
				...collaborators,
				prepareSource: async () => {
					if (invalid === 'prepare') throw new Error('source preparation failed')
					return source
				},
			})).rejects.toThrow()
			expect(zerops.calls).toEqual([])
			expect(disposed).toBe(invalid === 'setup')
		})
	}

	test('dry run prepares and disposes source but reserves and uploads nothing', async () => {
		const { zerops, collaborators } = fixture()
		let prepared = 0
		let disposed = 0
		await deployPlatform({ ...deployInput, dryRun: true }, {
			...collaborators,
			prepareSource: async () => {
				prepared++
				return {
					...fakePlatformSource(),
					dispose: async () => {
						disposed++
					},
				}
			},
			api: {
				...zerops.api,
				createAppVersion: async () => {
					throw new Error('must not reserve')
				},
			},
			uploadFetch: async () => {
				throw new Error('must not upload')
			},
		})
		expect([prepared, disposed]).toEqual([1, 1])
		expect(zerops.calls).toEqual([])
	})

	test('deploy distributes the same snapshot as a public namespace planning default before builds', async () => {
		const { zerops, collaborators } = fixture()
		const log = recordingInitLog()
		const commits: (string | undefined)[] = []
		const source = fakePlatformSource()
		let preparations = 0
		const run = () =>
			deployPlatform(deployInput, {
				...collaborators,
				log,
				prepareSource: async () => {
					preparations++
					return source
				},
				api: {
					...zerops.api,
					createAppVersion: async (call) => {
						const raw = zerops.env('control').get('FABRIKA_ZEROPS_PROXY_SOURCE_JSON') ?? ''
						expect(source.descriptor.contents).toContain('${RUNTIME_FABRIKA_PROXY_MANIFEST_JSON}')
						expect(raw).not.toContain('$')
						expect(raw).toContain('\\u0024{x_y}')
						const decoded = decodeZeropsNamespaceProxySource(JSON.parse(raw))
						expect(decoded).toEqual({
							...fakeNamespaceProxySource(),
							commitSha: source.commitSha,
						})
						await verifyZeropsNamespaceProxySource(decoded)
						commits.push(call.name)
						return zerops.api.createAppVersion(call)
					},
				},
			})
		await run()
		expect(preparations).toBe(1)
		expect(commits).toEqual(Array(4).fill(source.commitSha))
		expect(zerops.calls.filter((call) => call === 'env:control:FABRIKA_ZEROPS_PROXY_SOURCE_JSON')).toHaveLength(1)
		await run()
		expect(zerops.calls.filter((call) => call === 'env:control:FABRIKA_ZEROPS_PROXY_SOURCE_JSON')).toHaveLength(1)
		source.commitSha = 'c'.repeat(40)
		await run()
		expect(zerops.calls.filter((call) => call === 'env:control:FABRIKA_ZEROPS_PROXY_SOURCE_JSON')).toHaveLength(2)
		expect(log.lines.join('\n')).not.toContain(source.descriptor.contents)
	})

	test('descriptor digest disagreement fails before deploy environment writes or install project creation', async () => {
		const { zerops, collaborators } = fixture()
		const source = fakePlatformSource()
		source.descriptor = { ...source.descriptor, sha256: 'b'.repeat(64) }
		let disposed = 0
		source.dispose = async () => {
			disposed++
		}
		const invalid = { ...collaborators, prepareSource: async () => source }
		await expect(deployPlatform(deployInput, invalid)).rejects.toThrow()
		await expect(runInstall({
			project: { kind: 'create', projectName: 'new' },
			clientId: 'client',
			accessToken: 'token',
			environment: 'stage',
			scheme: 'https',
			sourceDir: '.',
			tier: 'light',
			unattended: true,
		}, { ...invalid, log: recordingInitLog(), prompts: { confirm: async () => true } })).rejects.toThrow()
		expect(zerops.calls).toEqual([])
		expect(disposed).toBe(2)
	})

	test('install validates every setup before creating a project', async () => {
		const { zerops, collaborators } = fixture()
		const install: InstallCollaborators = {
			...collaborators,
			log: recordingInitLog(),
			prompts: { confirm: async () => true },
			prepareSource: async () => ({
				...fakePlatformSource(),
				descriptor: { ...fakePlatformSource().descriptor, contents: 'zerops:\n  - setup: proxy\n' },
			}),
		}
		await expect(runInstall({
			project: { kind: 'create', projectName: 'new' },
			clientId: 'client',
			accessToken: 'token',
			environment: 'stage',
			scheme: 'https',
			sourceDir: '.',
			tier: 'light',
			unattended: true,
		}, install)).rejects.toThrow('selected setup')
		expect(zerops.calls).toEqual([])
	})

	test('both install passes upload the same prepared snapshot with fresh readers', async () => {
		const zerops = fakeZerops({
			projectId: 'project',
			projectName: 'new',
			projectMode: 'LIGHT',
			services: [],
			bootstrap: { clientId: 'client', imported: importedLightServices() },
		})
		let preparations = 0
		let disposals = 0
		const readers = new Set<BodyInit | null | undefined>()
		const names: (string | undefined)[] = []
		await runInstall({
			project: { kind: 'existing', projectId: 'project' },
			clientId: 'client',
			accessToken: 'token',
			environment: 'stage',
			scheme: 'https',
			sourceDir: '.',
			tier: 'light',
			unattended: true,
		}, {
			...fixture().collaborators,
			log: recordingInitLog(),
			prompts: { confirm: async () => true },
			prepareSource: async () => {
				preparations++
				return {
					...fakePlatformSource(),
					dispose: async () => {
						disposals++
					},
				}
			},
			api: {
				...zerops.api,
				createAppVersion: async (call) => {
					names.push(call.name)
					return zerops.api.createAppVersion(call)
				},
				putServiceEnv: async (call) => {
					if (call.key === 'FABRIKA_ZEROPS_PROXY_SOURCE_JSON') {
						expect(call.value).not.toContain('$')
						const decoded = decodeZeropsNamespaceProxySource(JSON.parse(call.value))
						expect(decoded).toEqual(fakeNamespaceProxySource())
						await verifyZeropsNamespaceProxySource(decoded)
					}
					return zerops.api.putServiceEnv(call)
				},
			},
			uploadFetch: async (url, init) => {
				readers.add(init.body)
				return fakeSourceCollaborators.uploadFetch(url, init)
			},
		})
		expect([preparations, disposals, readers.size]).toEqual([1, 1, 5])
		expect(names).toEqual(Array(5).fill('a'.repeat(40)))
		expect(zerops.calls.filter((call) => call === 'env:control:FABRIKA_ZEROPS_PROXY_SOURCE_JSON')).toHaveLength(1)
		const raw = zerops.env('control').get('FABRIKA_ZEROPS_PROXY_SOURCE_JSON') ?? ''
		expect(raw).not.toContain('$')
		expect(raw).toContain('\\u0024{FABRIKA_PROXY_MANIFEST_JSON}')
		const decoded = decodeZeropsNamespaceProxySource(JSON.parse(raw))
		expect(decoded).toEqual(fakeNamespaceProxySource())
		await verifyZeropsNamespaceProxySource(decoded)
	})
})

describe('reserved version lifecycle', () => {
	test('cleanup failure preserves the original upload failure without exposing response secrets', async () => {
		const { collaborators } = fixture()
		const log = recordingInitLog()
		let builds = 0
		let deletes = 0
		await expect(deployPlatformService({ id: 'svc-iam', hostname: 'iam' }, { source: fakePlatformSource(), dryRun: false }, {
			...collaborators,
			log,
			api: {
				...collaborators.api,
				deleteAppVersion: async () => {
					deletes++
					throw new Error('cleanup credential')
				},
				buildAndDeployAppVersion: async () => {
					builds++
					throw new Error('unexpected build')
				},
			},
			uploadFetch: async () => {
				throw new Error('upload credential')
			},
		})).rejects.toThrow('archive upload failed before build for app-version iam-v5')
		expect([builds, deletes]).toEqual([0, 1])
		expect(log.lines).toContain('warn: iam: cleanup unresolved for app-version iam-v5')
		expect(log.lines.join('\n')).not.toContain('credential')
	})

	test('abort during a known-rejected sync retry cleans only its unsubmitted reservation', async () => {
		const { collaborators } = fixture()
		const controller = new AbortController()
		const builds: string[] = []
		const deletes: string[] = []
		await expect(deployPlatformService({ id: 'svc-iam', hostname: 'iam' }, { source: fakePlatformSource(), dryRun: false }, {
			...collaborators,
			signal: controller.signal,
			sleep: async () => {
				controller.abort()
				throw new Error('retry wait cancelled')
			},
			api: {
				...collaborators.api,
				buildAndDeployAppVersion: async ({ appVersionId }) => {
					builds.push(appVersionId)
					throw new ZeropsApiError('sync', 400, 'userDataSyncRunning')
				},
				deleteAppVersion: async ({ appVersionId, signal }) => {
					expect(signal.aborted).toBe(false)
					expect(signal).not.toBe(controller.signal)
					deletes.push(appVersionId)
				},
			},
		})).rejects.toThrow('retry wait cancelled')
		expect(builds).toEqual(['iam-v5'])
		expect(deletes).toEqual(['iam-v5'])
	})

	test('abort after a possibly accepted build does not delete its reservation', async () => {
		const { collaborators } = fixture()
		const controller = new AbortController()
		let builds = 0
		let deletes = 0
		await expect(deployPlatformService({ id: 'svc-iam', hostname: 'iam' }, { source: fakePlatformSource(), dryRun: false }, {
			...collaborators,
			signal: controller.signal,
			api: {
				...collaborators.api,
				buildAndDeployAppVersion: async () => {
					builds++
					controller.abort()
					throw new Error('lost response')
				},
				deleteAppVersion: async () => {
					deletes++
				},
			},
		})).rejects.toThrow('deploy was cancelled')
		expect([builds, deletes]).toEqual([1, 0])
	})

	test('upload destination policy rejects before opening the archive or issuing PUT with a fixed error', async () => {
		const file = spyOn(Bun, 'file')
		let puts = 0
		try {
			for (
				const url of [
					'not a URL?signature=secret',
					'http://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?signature=secret',
					'HTTPS://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?signature=secret',
					'https://PROXY.APP-PRG1.ZEROPS.IO/api/rest/object-storage/upload?signature=secret',
					'https://proxy.app-prg1.zerops.io:443/api/rest/object-storage/upload?signature=secret',
					'https://user:secret@proxy.app-prg1.zerops.io/api/rest/object-storage/upload?signature=secret',
					'https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload',
					'https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?',
					'https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?signature=secret#fragment',
					'https://proxy.app-prg1.zerops.io/other?signature=secret',
				]
			) {
				let failure: unknown
				try {
					validatePlatformUploadUrl(url)
				} catch (error) {
					failure = error
				}
				expect(failure).toBeInstanceOf(Error)
				expect(failure).toMatchObject({ name: 'Error', message: 'Zerops archive upload destination rejected' })
				await expect(uploadPlatformArchive(url, '/missing-archive', new AbortController().signal, async () => {
					puts++
					return new Response(null)
				})).rejects.toThrow('Zerops archive upload destination rejected')
			}
			expect(file).not.toHaveBeenCalled()
			expect(puts).toBe(0)
		} finally {
			file.mockRestore()
		}
	})

	test.each([
		{ name: 'signed query', query: 'signature=secret' },
		{ name: 'opaque query', query: 'x' },
		{ name: 'ampersand query', query: '&' },
		{ name: 'empty fragment', query: 'signature=secret#' },
		{ name: 'query space', query: 'signature=sec ret' },
		{ name: 'query tab', query: 'signature=sec\tret' },
		{ name: 'long query', query: `signature=${'x'.repeat(4096)}` },
	])('PUT preserves original $name, carries only archive, rejects redirects and uses a bounded signal', async ({ query }) => {
		const signal = new AbortController().signal
		const url = `https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?${query}`
		let responseCancelled = false
		await uploadPlatformArchive(url, '/dev/null', signal, async (destination, init) => {
			expect(destination).toBe(url)
			expect(init.method).toBe('PUT')
			expect(init.redirect).toBe('error')
			expect(init.headers).toBeUndefined()
			expect(init.signal).not.toBe(signal)
			await new Response(init.body).arrayBuffer()
			return new Response(
				new ReadableStream({
					cancel: () => {
						responseCancelled = true
					},
				}),
			)
		})
		expect(responseCancelled).toBe(true)
	})

	for (const rejectedUrl of [false, true]) {
		test(`${rejectedUrl ? 'invalid destination' : 'failed upload'} deletes reservation without building`, async () => {
			const { collaborators } = fixture()
			const calls: string[] = []
			const controller = new AbortController()
			await expect(deployPlatformService({ id: 'svc-iam', hostname: 'iam' }, { source: fakePlatformSource(), dryRun: false }, {
				...collaborators,
				signal: controller.signal,
				api: {
					...collaborators.api,
					createAppVersion: async () => ({
						id: 'reserved',
						uploadUrl: rejectedUrl ? 'https://evil.test/?secret' : 'https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?secret',
					}),
					deleteAppVersion: async ({ appVersionId, signal }) => {
						expect(signal.aborted).toBe(false)
						calls.push(`delete:${appVersionId}`)
					},
					buildAndDeployAppVersion: async () => {
						calls.push('build')
						throw new Error('unexpected build')
					},
				},
				uploadFetch: async () => {
					calls.push('upload')
					controller.abort()
					throw new Error('secret signed URL')
				},
			})).rejects.toThrow('archive upload failed before build')
			expect(calls).toEqual(rejectedUrl ? ['delete:reserved'] : ['upload', 'delete:reserved'])
		})
	}

	const observedStatuses: readonly ZeropsAppVersionStatus[] = ['ACTIVE', 'UPLOADING']
	for (const status of observedStatuses) {
		test(`ambiguous build observes reserved version (${status}) without duplicate or delete`, async () => {
			const { collaborators } = fixture()
			let builds = 0
			let polls = 0
			let deletes = 0
			const run = deployPlatformService({ id: 'svc-iam', hostname: 'iam' }, { source: fakePlatformSource(), dryRun: false }, {
				...collaborators,
				api: {
					...collaborators.api,
					createAppVersion: async () => ({ id: 'reserved', uploadUrl: 'https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?secret' }),
					buildAndDeployAppVersion: async (call) => {
						expect(call.appVersionId).toBe('reserved')
						expect(call.zeropsYamlSetup).toBe('iam')
						expect(call.zeropsYaml).toBe(prepareZeropsDescriptor(fakePlatformSource().descriptor.contents, 'iam').contents)
						builds++
						throw new Error('response with secret URL')
					},
					getAppVersion: async ({ appVersionId }) => {
						expect(appVersionId).toBe('reserved')
						polls++
						return { id: appVersionId, status }
					},
					deleteAppVersion: async () => {
						deletes++
					},
				},
			})
			if (status === 'ACTIVE') await run
			else await expect(run).rejects.toThrow('unresolved after timeout')
			expect(builds).toBe(1)
			expect(deletes).toBe(0)
			expect(polls).toBeGreaterThan(0)
		})
	}

	test('known sync rejection retries the same reserved ID', async () => {
		const { collaborators } = fixture()
		const ids: string[] = []
		await deployPlatformService({ id: 'svc-iam', hostname: 'iam' }, { source: fakePlatformSource(), dryRun: false }, {
			...collaborators,
			api: {
				...collaborators.api,
				buildAndDeployAppVersion: async ({ appVersionId }) => {
					ids.push(appVersionId)
					if (ids.length === 1) throw new ZeropsApiError('sync', 400, 'userDataSyncRunning')
					return { id: 'process', appVersionId }
				},
			},
		})
		expect(ids).toEqual(['iam-v5', 'iam-v5'])
	})
})
