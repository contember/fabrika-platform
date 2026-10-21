import { ProviderInvocationAbort, ProviderNamespaceError } from '@fabrika/provider-contract'
import type { InstallationBrand } from '@fabrika/proxy-core/brand'
import { contractProxyTable, FABRIKA_PROXY_MANIFEST_JSON, type ProxyManifest } from '@fabrika/proxy-core/manifest'
import { expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { createZeropsApi, ZEROPS_SERVICE_ENV_VALUE_TOO_LARGE, ZeropsApiError, type ZeropsAppVersionStatus } from '../api'
import { createZeropsArtifactSourceDescriptor } from '../manifest'
import { createZeropsNamespaceCapabilities } from '../namespace'
import { zeropsNamespaceTargetCodec } from '../namespace/codec'
import { ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE, ZEROPS_NAMESPACE_IAM_KEY_VARIABLE } from '../namespace/constants'
import { asNamespaceError } from '../namespace/errors'
import { compileNamespaceProxyManifest } from '../namespace/manifest'
import { republishProxy, type ZeropsProxyApi, type ZeropsProxyRepublishInput } from '../namespace/proxy-attempt'
import type { ZeropsNamespaceTarget } from '../namespace/types'
import { FABRIKA_PROXY_MANIFEST_BRAND } from '../proxy-manifest-carrier'
import type { ZeropsSourceArchive, ZeropsSourcePort } from '../source/port'

const pin = {
	repository: { owner: 'example', name: 'platform' },
	commitSha: 'a'.repeat(40),
	descriptor: await createZeropsArtifactSourceDescriptor('zerops:\n  - setup: proxy\n'),
}
/** A namespace kept on a release whose proxy build still lifts the manifest variable (ADR-0045). */
const legacyPin = {
	...pin,
	commitSha: 'b'.repeat(40),
	descriptor: await createZeropsArtifactSourceDescriptor(
		`zerops:\n  - setup: proxy\n    build:\n      envVariables:\n        ${FABRIKA_PROXY_MANIFEST_JSON}: "\${RUNTIME_${FABRIKA_PROXY_MANIFEST_JSON}}"\n`,
	),
}
/** A namespace pinned to a source whose proxy parser knows the manifest's `brand` (ADR-0066). */
const brandPin = {
	...pin,
	commitSha: 'c'.repeat(40),
	descriptor: await createZeropsArtifactSourceDescriptor(
		`zerops:\n  - setup: proxy\n    build:\n      envVariables:\n        ${FABRIKA_PROXY_MANIFEST_BRAND}: "1"\n`,
	),
}
const LOGO: InstallationBrand = {
	light: { type: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' },
}
const sha256 = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex')
const EMPTY: ProxyManifest = { apps: [] }
const CHANGED: ProxyManifest = {
	apps: [{ id: 'app', hosts: ['app.example.test'], upstream: 'app:3000', scheme: 'https', ...contractProxyTable(notesArtifact) }],
}

function fixture(proxySource = pin) {
	const calls: string[] = []
	const sensitivity = new Map<string, boolean>()
	const uploadedArchives: ZeropsSourceArchive[] = []
	let target: ZeropsNamespaceTarget = { proxyServiceId: 'proxy', projectId: 'project', proxySource, ready: true }
	let status: ZeropsAppVersionStatus = 'ACTIVE'
	let sequence = 0
	const deleted = new Set<string>()
	const api: ZeropsProxyApi = {
		listServiceEnv: async () => [{ id: 'issuer', key: ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE, sensitive: false, content: 'https://iam.stale.example' }],
		putServiceEnv: async input => {
			calls.push(`env:${input.key}`)
			sensitivity.set(input.key, input.sensitive)
		},
		deleteServiceEnv: async input => {
			calls.push(`unset:${input.envId}`)
		},
		createAppVersion: async () => {
			sequence++
			calls.push(`reserve:v${sequence}`)
			return { id: `v${sequence}`, uploadUrl: `https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?version=v${sequence}&secret=redacted` }
		},
		deleteAppVersion: async input => {
			calls.push(`delete:${input.appVersionId}`)
			deleted.add(input.appVersionId)
		},
		buildAndDeployAppVersion: async input => {
			calls.push(`build:${input.appVersionId}`)
			expect(input.zeropsYamlSetup).toBe('proxy')
			expect(input.zeropsYaml).toContain('setup: proxy')
			return { id: 'process', appVersionId: input.appVersionId }
		},
		getAppVersion: async input => {
			calls.push(`observe:${input.appVersionId}`)
			if (deleted.has(input.appVersionId)) throw new ZeropsApiError('absent', 400, 'appVersionNotFound')
			return { id: input.appVersionId, status, serviceStackId: 'proxy' }
		},
	}
	const source: ZeropsSourcePort = {
		resolve: async input => {
			calls.push('resolve')
			expect(input.requestedRef).toBe(proxySource.commitSha)
			expect(input.expectedCommitSha).toBe(proxySource.commitSha)
			expect(input.privateBinding).toBeUndefined()
			return { commitSha: proxySource.commitSha, descriptorSha256: proxySource.descriptor.sha256 }
		},
		upload: async input => {
			calls.push(`upload:${new URL(input.uploadUrl).searchParams.get('version')}`)
			// ADR-0045: a platform archive is anonymous; it names no connection, and carries at most the manifest.
			if (input.archive.kind !== 'platform') throw new Error('expected a platform archive')
			uploadedArchives.push(input.archive)
			const dataFile = input.archive.dataFile
			return {
				commitSha: input.commitSha,
				descriptorSha256: input.descriptorSha256,
				...(dataFile === undefined ? {} : { dataFileSha256: sha256(dataFile.contents) }),
				entryCount: 1,
				expandedBytes: 1,
			}
		},
	}
	const controller = new AbortController()
	const input = (): ZeropsProxyRepublishInput => ({
		namespaceId: 'apps-prod',
		target,
		manifest: EMPTY,
		source,
		api,
		iamUrl: 'https://iam.example.test',
		iamKey: 'not-logged',
		signal: controller.signal,
		wait: 'started',
		reuseActive: false,
		sleep: async () => {},
		boundary: async () => {
			calls.push('boundary')
		},
		checkpoint: async next => {
			target = zeropsNamespaceTargetCodec.decode(zeropsNamespaceTargetCodec.encode(next))
		},
	})
	return {
		calls,
		sensitivity,
		uploadedArchives,
		api,
		source,
		controller,
		input,
		target: () => target,
		status: (value: ZeropsAppVersionStatus) => {
			status = value
		},
	}
}

const effects = (calls: string[]) => calls.filter(call => !/^(boundary|resolve|observe:)/.test(call))

test('started publishes routing and IAM before the build and returns once the build is accepted', async () => {
	const f = fixture()
	const result = await republishProxy(f.input())
	expect(effects(f.calls)).toEqual([
		'env:FABRIKA_PROXY_SESSION_OWNER_JSON',
		`env:${ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE}`,
		`env:${ZEROPS_NAMESPACE_IAM_KEY_VARIABLE}`,
		'reserve:v1',
		'upload:v1',
		'build:v1',
	])
	expect(f.calls.some(call => call.startsWith('observe:'))).toBe(false)
	expect(result.proxyBuild).toEqual({ appVersionId: 'v1', triggered: true, manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
	expect(JSON.stringify(f.target())).not.toContain('not-logged')
})

test('active polls the exact version to ACTIVE and records it as the deployment of that manifest', async () => {
	const f = fixture()
	const result = await republishProxy({ ...f.input(), wait: 'active' })
	expect(result.proxyBuild).toBeUndefined()
	expect(result.proxyDeployment).toEqual({
		appVersionId: 'v1',
		repository: pin.repository,
		commitSha: pin.commitSha,
		descriptorSha256: pin.descriptor.sha256,
		manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
	})
	expect(f.calls.indexOf('observe:v1')).toBeGreaterThan(f.calls.indexOf('build:v1'))
})

test('an inherited untriggered attempt is deleted, never built, and replaced by a fresh one', async () => {
	const f = fixture()
	await f.input().checkpoint({ ...f.target(), proxyBuild: { appVersionId: 'v0', triggered: false } })
	const result = await republishProxy(f.input())
	expect(effects(f.calls).slice(0, 2)).toEqual(['delete:v0', 'env:FABRIKA_PROXY_SESSION_OWNER_JSON'])
	expect(f.calls).not.toContain('build:v0')
	expect(result.proxyBuild?.appVersionId).toBe('v1')
})

test('an inherited untriggered attempt whose deletion is unconfirmed stays recorded and blocks a new one', async () => {
	const f = fixture()
	await f.input().checkpoint({ ...f.target(), proxyBuild: { appVersionId: 'v0', triggered: false } })
	f.api.deleteAppVersion = async () => {
		throw new Error('deletion unknown')
	}
	await expect(republishProxy(f.input())).rejects.toThrow('v0 remains unresolved')
	expect(f.target().proxyBuild).toEqual({ appVersionId: 'v0', triggered: false })
	expect(f.calls.some(call => /reserve:|build:/.test(call))).toBe(false)
})

test('an inherited triggered attempt is polled, never deleted; a newer manifest waits until it settles', async () => {
	const f = fixture()
	f.status('BUILDING')
	const first = await republishProxy(f.input())
	const priorDigest = first.proxyBuild?.manifestSha256
	f.calls.length = 0
	await expect(republishProxy({ ...f.input(), manifest: CHANGED })).rejects.toThrow('v1 remains unresolved')
	expect(f.calls).toEqual(['boundary', 'observe:v1'])
	f.status('ACTIVE')
	const second = await republishProxy({ ...f.input(), manifest: CHANGED })
	expect(second.proxyDeployment?.appVersionId).toBe('v1')
	expect(second.proxyDeployment?.manifestSha256).toBe(priorDigest)
	expect(second.proxyBuild?.appVersionId).toBe('v2')
	expect(second.proxyBuild?.manifestSha256).not.toBe(priorDigest)
	expect(f.calls.some(call => call.startsWith('delete:'))).toBe(false)
})

test('an inherited triggered attempt of the same manifest settles without another build', async () => {
	const f = fixture()
	await republishProxy(f.input())
	f.calls.length = 0
	const result = await republishProxy({ ...f.input(), wait: 'active' })
	expect(result.proxyDeployment?.appVersionId).toBe('v1')
	expect(effects(f.calls)).toEqual([])
})

test('a republish of the manifest the ACTIVE proxy already serves reuses it, with no write and no build', async () => {
	const f = fixture()
	const secrets = new Map([['FABRIKA_PROXY_SECRET_A', 'secret-one']])
	await republishProxy({ ...f.input(), wait: 'active', proxySecrets: secrets })
	f.calls.length = 0
	const result = await republishProxy({ ...f.input(), wait: 'active', reuseActive: true, proxySecrets: secrets })
	expect(result.proxyDeployment?.appVersionId).toBe('v1')
	expect(f.calls).toEqual(['boundary', 'observe:v1'])
})

test('a republish rebuilds when the manifest, a secret, the pin or the ACTIVE version differs from the deployment', async () => {
	const changes: { readonly name: string; readonly change: (f: ReturnType<typeof fixture>) => Promise<Partial<ZeropsProxyRepublishInput>> }[] = [
		{ name: 'manifest', change: async () => ({ manifest: CHANGED }) },
		{ name: 'secret', change: async () => ({ proxySecrets: new Map([['FABRIKA_PROXY_SECRET_A', 'secret-two']]) }) },
		{ name: 'IAM key', change: async () => ({ iamKey: 'rotated-key' }) },
		{
			name: 'pin',
			change: async (f) => {
				const deployed = f.target().proxyDeployment
				if (deployed === undefined) throw new Error('expected a deployment')
				await f.input().checkpoint({ ...f.target(), proxyDeployment: { ...deployed, commitSha: 'c'.repeat(40) } })
				return {}
			},
		},
		{
			name: 'version',
			change: async (f) => {
				f.status('BACKUP')
				return {}
			},
		},
		{
			name: 'unreadable version',
			change: async (f) => {
				f.api.getAppVersion = async () => {
					throw new Error('unreachable')
				}
				return {}
			},
		},
	]
	for (const { name, change } of changes) {
		const f = fixture()
		const secrets = new Map([['FABRIKA_PROXY_SECRET_A', 'secret-one']])
		await republishProxy({ ...f.input(), wait: 'active', proxySecrets: secrets })
		const changed = await change(f)
		f.calls.length = 0
		await republishProxy({ ...f.input(), wait: 'started', reuseActive: true, proxySecrets: secrets, ...changed })
		expect({ name, built: f.calls.includes('build:v2') }).toEqual({ name, built: true })
	}
})

test('without reuseActive a republish of the same manifest rebuilds, so a reconcile always reaches the platform', async () => {
	const f = fixture()
	await republishProxy({ ...f.input(), wait: 'active' })
	f.calls.length = 0
	await republishProxy({ ...f.input(), wait: 'started' })
	expect(f.calls).toContain('build:v2')
})

for (const rotation of ['issuer', 'key'] as const) {
	test(`a rotated IAM ${rotation} rebuilds after an inherited attempt of the same manifest settles`, async () => {
		const f = fixture()
		await republishProxy(f.input())
		f.calls.length = 0
		const input = f.input()
		const result = await republishProxy({
			...input,
			wait: 'active',
			...(rotation === 'issuer' ? { iamUrl: 'https://iam.rotated.example.test' } : { iamKey: 'rotated-key' }),
		})
		expect(result.proxyDeployment?.appVersionId).toBe('v2')
		expect(f.calls).toContain(`env:${ZEROPS_NAMESPACE_IAM_KEY_VARIABLE}`)
		expect(f.calls).toContain('build:v2')
		expect(JSON.stringify(f.target())).not.toContain('rotated-key')
	})
}

test('writes every proxy secret before the version is reserved, and a changed secret rebuilds', async () => {
	const f = fixture()
	const secrets = new Map([['FABRIKA_PROXY_SECRET_A', 'secret-one']])
	await republishProxy({ ...f.input(), proxySecrets: secrets })
	expect(f.calls.indexOf('env:FABRIKA_PROXY_SECRET_A')).toBeGreaterThan(-1)
	expect(f.calls.indexOf('env:FABRIKA_PROXY_SECRET_A')).toBeLessThan(f.calls.indexOf('reserve:v1'))
	f.calls.length = 0
	const result = await republishProxy({ ...f.input(), wait: 'active', proxySecrets: new Map([['FABRIKA_PROXY_SECRET_A', 'secret-two']]) })
	expect(result.proxyDeployment?.appVersionId).toBe('v2')
	expect(f.calls).toContain('build:v2')
	expect(JSON.stringify(f.target())).not.toContain('secret-')
})

test('writes routing and the issuer readable and every credential sensitive', async () => {
	const f = fixture()
	await republishProxy({ ...f.input(), proxySecrets: new Map([['FABRIKA_PROXY_SECRET_A', 'secret-one']]) })
	expect(Object.fromEntries(f.sensitivity)).toEqual({
		FABRIKA_PROXY_SESSION_OWNER_JSON: false,
		[ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE]: false,
		[ZEROPS_NAMESPACE_IAM_KEY_VARIABLE]: true,
		FABRIKA_PROXY_SECRET_A: true,
	})
})

test('an issuer that cannot be read back is rewritten readable', async () => {
	const f = fixture()
	f.api.listServiceEnv = async () => [
		{ id: 'issuer', key: ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE, sensitive: true },
		{ id: 'owner', key: 'FABRIKA_PROXY_SESSION_OWNER_JSON', sensitive: true },
	]
	await republishProxy({ ...f.input(), iamUrl: 'https://iam.stale.example' })
	expect(f.calls).toContain(`env:${ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE}`)
	expect(f.calls).toContain('env:FABRIKA_PROXY_SESSION_OWNER_JSON')
	expect(f.sensitivity.get(ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE)).toBe(false)
	expect(f.sensitivity.get('FABRIKA_PROXY_SESSION_OWNER_JSON')).toBe(false)
})

test('an issuer already readable at the requested value is not rewritten', async () => {
	const f = fixture()
	await republishProxy({ ...f.input(), iamUrl: 'https://iam.stale.example' })
	expect(f.calls).not.toContain(`env:${ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE}`)
})

test('a lost build response stays a triggered attempt that is observed, never deleted or resubmitted', async () => {
	const f = fixture()
	f.status('UPLOADING')
	f.api.buildAndDeployAppVersion = async input => {
		f.calls.push(`build:${input.appVersionId}`)
		throw new Error('response lost')
	}
	await expect(republishProxy(f.input())).rejects.toThrow('v1 remains unresolved')
	expect(f.target().proxyBuild).toMatchObject({ appVersionId: 'v1', triggered: true })
	f.calls.length = 0
	await expect(republishProxy(f.input())).rejects.toThrow('v1 remains unresolved')
	expect(effects(f.calls)).toEqual([])
})

test('a failure before the build request deletes the reserved version and clears the attempt', async () => {
	const f = fixture()
	await expect(republishProxy({
		...f.input(),
		source: {
			...f.source,
			upload: async () => {
				throw new Error('upload failed')
			},
		},
	})).rejects.toThrow('upload failed')
	expect(effects(f.calls).slice(-1)).toEqual(['delete:v1'])
	expect(f.calls).not.toContain('build:v1')
	expect(f.target().proxyBuild).toBeUndefined()
})

test('a cancellation read before the build request deletes the reserved version', async () => {
	const f = fixture()
	const input = f.input()
	await expect(republishProxy({
		...input,
		boundary: async () => {
			if (f.calls.includes('upload:v1')) throw new ProviderInvocationAbort('cancel_requested')
		},
	})).rejects.toMatchObject({ kind: 'cancel_requested' })
	expect(f.calls).toContain('delete:v1')
	expect(f.calls).not.toContain('build:v1')
	expect(f.target().proxyBuild).toBeUndefined()
})

test('a cancellation after the build request leaves the triggered attempt recorded for reconciliation', async () => {
	const f = fixture()
	f.status('BUILDING')
	await expect(republishProxy({
		...f.input(),
		wait: 'active',
		boundary: async () => {
			if (f.calls.includes('build:v1')) throw new ProviderInvocationAbort('cancel_requested')
		},
	})).rejects.toMatchObject({ kind: 'cancel_requested' })
	expect(f.target().proxyBuild).toMatchObject({ appVersionId: 'v1', triggered: true })
	expect(f.calls.some(call => call.startsWith('delete:'))).toBe(false)
})

test('lease loss during upload neither deletes nor builds, and leaves the untriggered attempt to the next owner', async () => {
	const f = fixture()
	await expect(republishProxy({
		...f.input(),
		source: {
			...f.source,
			upload: async () => {
				f.controller.abort(new ProviderInvocationAbort('lease_lost'))
				throw f.controller.signal.reason
			},
		},
	})).rejects.toMatchObject({ kind: 'lease_lost' })
	expect(f.calls.some(call => /delete:|cancel|build:/.test(call))).toBe(false)
	expect(f.target().proxyBuild).toMatchObject({ appVersionId: 'v1', triggered: false })
})

test('userDataSyncRunning restores the untriggered checkpoint before retrying the same version', async () => {
	const f = fixture()
	const recorded: Array<boolean | undefined> = []
	let refusals = 1
	const build = f.api.buildAndDeployAppVersion
	f.api.buildAndDeployAppVersion = async input => {
		if (refusals-- > 0) throw new ZeropsApiError('sync running', 400, 'userDataSyncRunning')
		return build(input)
	}
	const input = f.input()
	await republishProxy({
		...input,
		checkpoint: async next => {
			recorded.push(next.proxyBuild?.triggered)
			await input.checkpoint(next)
		},
	})
	expect(recorded).toEqual([false, true, false, true])
	expect(f.calls.filter(call => call.startsWith('reserve:'))).toEqual(['reserve:v1'])
})

test('resolution failure, an invalid descriptor digest and an unpinned target cause no external writes', async () => {
	const f = fixture()
	await expect(republishProxy({
		...f.input(),
		source: {
			...f.source,
			resolve: async () => {
				throw new Error('source unavailable')
			},
		},
	})).rejects.toThrow('source unavailable')
	await expect(republishProxy({
		...f.input(),
		target: { ...f.target(), proxySource: { ...pin, descriptor: { ...pin.descriptor, sha256: '0'.repeat(64) } } },
	})).rejects.toThrow()
	expect(effects(f.calls)).toEqual([])
})

test("the manifest travels as the archive's data file and never through the environment", async () => {
	const f = fixture()
	await republishProxy({ ...f.input(), manifest: CHANGED })
	expect(f.uploadedArchives).toEqual([{ kind: 'platform', dataFile: { path: 'proxy.manifest.json', contents: JSON.stringify(CHANGED) } }])
	expect(f.calls).not.toContain(`env:${FABRIKA_PROXY_MANIFEST_JSON}`)
})

test("the installation's client logo rides in the manifest only to a proxy whose pin parses it, and a new logo rebuilds", async () => {
	const archived = (f: ReturnType<typeof fixture>, index: number): unknown => {
		const archive = f.uploadedArchives[index]
		return JSON.parse(archive?.kind === 'platform' ? archive.dataFile?.contents ?? '{}' : '{}')
	}
	const accepting = fixture(brandPin)
	await republishProxy({ ...accepting.input(), manifest: CHANGED, brand: LOGO })
	expect(archived(accepting, 0)).toEqual({ ...CHANGED, brand: LOGO })

	// An older parser refuses the key and would fail the build, so that pin keeps the mark.
	const older = fixture()
	await republishProxy({ ...older.input(), manifest: CHANGED, brand: LOGO })
	expect(archived(older, 0)).toEqual(CHANGED)

	const unbranded = fixture(brandPin)
	const first = await republishProxy({ ...unbranded.input(), manifest: CHANGED, wait: 'active' })
	const second = await republishProxy({ ...unbranded.input(), manifest: CHANGED, brand: LOGO, wait: 'active' })
	expect(second.proxyDeployment?.manifestSha256).not.toBe(first.proxyDeployment?.manifestSha256)
	expect(archived(unbranded, 1)).toEqual({ ...CHANGED, brand: LOGO })
})

test('a 1 MB manifest reaches the build through the archive', async () => {
	const f = fixture()
	const large: ProxyManifest = {
		apps: Array.from({ length: 220 }, (_, index) => ({
			id: `app${index}@prod`,
			hosts: [`app${index}.example.test`],
			upstream: `app${index}:3000`,
			scheme: 'https',
			...contractProxyTable(notesArtifact),
		})),
	}
	const result = await republishProxy({ ...f.input(), manifest: large })
	const contents = f.uploadedArchives[0]?.kind === 'platform' ? f.uploadedArchives[0].dataFile?.contents ?? '' : ''
	expect(new TextEncoder().encode(contents).byteLength).toBeGreaterThan(1024 * 1024)
	expect(contents).toBe(JSON.stringify(large))
	expect(f.calls).toContain('build:v1')
	expect(result.proxyBuild?.triggered).toBe(true)
})

test('a manifest left in the environment by an earlier release is removed', async () => {
	const f = fixture()
	const listed = await f.api.listServiceEnv({ serviceId: 'proxy', signal: new AbortController().signal })
	f.api.listServiceEnv = async () => [...listed, { id: 'stale-manifest', key: FABRIKA_PROXY_MANIFEST_JSON, sensitive: false, content: '{"apps":[]}' }]
	await republishProxy(f.input())
	expect(f.calls.indexOf('unset:stale-manifest')).toBeGreaterThan(-1)
	expect(f.calls.indexOf('unset:stale-manifest')).toBeLessThan(f.calls.indexOf('reserve:v1'))
})

test('an upload that does not report the manifest it carried is an identity mismatch, never built', async () => {
	const f = fixture()
	f.source.upload = async input => ({ commitSha: input.commitSha, descriptorSha256: input.descriptorSha256, entryCount: 1, expandedBytes: 1 })
	await expect(republishProxy(f.input())).rejects.toThrow('Proxy source upload identity mismatch')
	expect(f.calls.some(call => call.startsWith('build:'))).toBe(false)
})

test('a namespace pinned to a release that lifts the variable gets the variable and an archive without a data file', async () => {
	const f = fixture(legacyPin)
	await republishProxy({ ...f.input(), manifest: CHANGED })
	expect(effects(f.calls).slice(0, 2)).toEqual([`env:${FABRIKA_PROXY_MANIFEST_JSON}`, 'env:FABRIKA_PROXY_SESSION_OWNER_JSON'])
	expect(f.uploadedArchives).toEqual([{ kind: 'platform' }])
	expect(f.sensitivity.get(FABRIKA_PROXY_MANIFEST_JSON)).toBe(false)
})

test('on a pin that lifts the variable, a manifest over its limit is refused before anything is written, and no retry can pass', async () => {
	const f = fixture(legacyPin)
	const requests: string[] = []
	// The real client's write, over a platform that answers a bare 500 from 32,768 bytes (issue #3).
	const platform = createZeropsApi({
		token: 'unused',
		baseUrl: 'https://zerops.test',
		fetchImpl: async (url, init) => {
			requests.push(`${init?.method ?? 'GET'} ${url}`)
			return new Response(null, { status: 500 })
		},
	})
	const large: ProxyManifest = {
		apps: Array.from({ length: 10 }, (_, index) => ({
			id: `app${index}@prod`,
			hosts: [`app${index}.example.test`],
			upstream: `app${index}:3000`,
			scheme: 'https',
			...contractProxyTable(notesArtifact),
		})),
	}

	const error = await republishProxy({ ...f.input(), manifest: large, api: { ...f.api, putServiceEnv: platform.putServiceEnv } }).then(
		() => null,
		(cause: unknown) => cause,
	)

	expect(error).toBeInstanceOf(ProviderNamespaceError)
	expect(String(error)).toContain('fabrika control namespaces update --namespace=apps-prod --proxy-source=current')
	expect(requests).toEqual([])
	expect(effects(f.calls)).toEqual([])
	expect(f.target().proxyBuild).toBeUndefined()
	const classified = asNamespaceError(error, 'reconcile')
	expect(classified.code).toBe(ZEROPS_SERVICE_ENV_VALUE_TOO_LARGE)
	expect(classified.retryable).toBe(false)
	expect(classified.message).toContain(`\`${FABRIKA_PROXY_MANIFEST_JSON}\``)
})

test('the republish capability refuses a namespace with no proxy or one that is not ready, before any platform call', async () => {
	const calls: string[] = []
	const capabilities = createZeropsNamespaceCapabilities({
		clientId: 'client',
		proxySource: pin,
		iamUrl: 'https://iam.example.test',
		iamKey: 'not-logged',
		api: {
			...createZeropsApi({
				token: 'unused',
				fetchImpl: async (url) => {
					calls.push(String(url))
					throw new Error('no platform call expected')
				},
			}),
		},
	})
	const republish = capabilities.republish
	if (republish === undefined) throw new Error('republish capability missing')
	for (
		const target of [{ proxySource: pin, projectId: 'project', ready: true }, {
			proxySource: pin,
			projectId: 'project',
			proxyServiceId: 'proxy',
			ready: false,
		}]
	) {
		await expect(republish({
			namespace: { id: 'apps-prod', env: 'prod', target: { provider: 'zerops', version: 1, payload: zeropsNamespaceTargetCodec.encode(target) } },
			members: [],
			wait: 'started',
			signal: new AbortController().signal,
			events: { checkpoint: async () => {}, boundary: async () => {} },
		})).rejects.toThrow('not ready')
	}
	expect(calls).toEqual([])
})

test("a deploy's republish reuses the ACTIVE proxy of an unchanged manifest; only its version is read", async () => {
	const f = fixture()
	await republishProxy({ ...f.input(), manifest: compileNamespaceProxyManifest('apps-prod', []), wait: 'active' })
	const deployed = f.target().proxyDeployment
	if (deployed === undefined) throw new Error('expected a deployment')
	const calls: string[] = []
	const capabilities = createZeropsNamespaceCapabilities({
		clientId: 'client',
		proxySource: pin,
		iamUrl: 'https://iam.example.test',
		iamKey: 'not-logged',
		api: {
			...createZeropsApi({
				token: 'unused',
				fetchImpl: async (url) => {
					calls.push(String(url))
					throw new Error('no other platform call expected')
				},
			}),
			getAppVersion: async (input) => {
				calls.push(`observe:${input.appVersionId}`)
				return { id: input.appVersionId, status: 'ACTIVE', serviceStackId: 'proxy' }
			},
		},
	})
	const republish = capabilities.republish
	if (republish === undefined) throw new Error('republish capability missing')
	const result = await republish({
		namespace: { id: 'apps-prod', env: 'prod', target: { provider: 'zerops', version: 1, payload: zeropsNamespaceTargetCodec.encode(f.target()) } },
		members: [],
		wait: 'active',
		signal: new AbortController().signal,
		events: { checkpoint: async () => {}, boundary: async () => {} },
	})
	expect(result.settled).toBe(true)
	expect(calls).toEqual([`observe:${deployed.appVersionId}`])
})
