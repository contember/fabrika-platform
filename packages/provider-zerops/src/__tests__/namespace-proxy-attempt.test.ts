import { ProviderInvocationAbort } from '@fabrika/provider-contract'
import { expect, test } from 'bun:test'
import type { ZeropsAppVersionStatus } from '../api'
import { createZeropsArtifactSourceDescriptor } from '../manifest'
import { zeropsNamespaceTargetCodec } from '../namespace/codec'
import { runZeropsProxyAttempt, type ZeropsProxyAttemptApi, type ZeropsProxyAttemptInput } from '../namespace/proxy-attempt'
import type { ZeropsNamespaceTarget } from '../namespace/types'
import type { ZeropsSourceClient } from '../source'

const pin = {
	repository: { owner: 'example', name: 'platform' },
	commitSha: 'a'.repeat(40),
	descriptor: await createZeropsArtifactSourceDescriptor('zerops:\n  - setup: proxy\n'),
}
const changedManifest = JSON.stringify({
	apps: [{ id: 'app', hosts: ['app.example.test'], upstream: 'app:3000', gates: { rules: [{ path: '/*', kind: 'public' }] }, scheme: 'https' }],
})

function fixture() {
	const calls: string[] = []
	let target: ZeropsNamespaceTarget = { proxyServiceId: 'proxy', projectId: 'project', proxySource: pin, ready: true }
	let status: ZeropsAppVersionStatus = 'ACTIVE'
	let sequence = 0
	const api: ZeropsProxyAttemptApi = {
		listServiceEnv: async () => [],
		putServiceEnv: async input => {
			calls.push(`env:${input.key}`)
		},
		createAppVersion: async () => {
			sequence++
			calls.push(`reserve:v${sequence}`)
			return { id: `v${sequence}`, uploadUrl: 'https://upload.example.test?secret=redacted' }
		},
		deleteAppVersion: async input => {
			calls.push(`delete:${input.appVersionId}`)
		},
		buildAndDeployAppVersion: async input => {
			calls.push(`build:${input.appVersionId}`)
			expect(input.zeropsYamlSetup).toBe('proxy')
			expect(input.zeropsYaml).toContain('setup: proxy')
			return { id: 'process', appVersionId: input.appVersionId }
		},
		getAppVersion: async input => {
			calls.push(`observe:${input.appVersionId}`)
			return { id: input.appVersionId, status }
		},
		cancelBuild: async input => {
			calls.push(`cancelBuild:${input.appVersionId}`)
		},
	}
	const source: ZeropsSourceClient = {
		resolve: async input => {
			calls.push('resolve')
			expect(input.repository).toEqual(pin.repository)
			expect(input.requestedRef).toBe(pin.commitSha)
			expect(input.expectedCommitSha).toBe(pin.commitSha)
			return { runId: input.runId, commitSha: pin.commitSha, descriptorSha256: pin.descriptor.sha256 }
		},
		upload: async input => {
			calls.push(`upload:${input.appVersionId}`)
			expect(input.archiveKind).toBe('platform')
			expect(input.githubInstallationId).toBeUndefined()
			expect(input.uploadUrl).toBe('https://upload.example.test?secret=redacted')
			return { runId: input.runId, appVersionId: input.appVersionId, commitSha: input.commitSha, descriptorSha256: input.descriptor.sha256 }
		},
		cancel: async input => {
			calls.push(`cancelSource:${input.appVersionId}`)
		},
	}
	const controller = new AbortController()
	const input = (): ZeropsProxyAttemptInput => ({
		target,
		manifest: '{"apps":[]}',
		source,
		api,
		iamUrl: 'https://iam.example.test',
		iamKey: 'not-logged',
		signal: controller.signal,
		wait: 'started',
		sleep: async () => {},
		checkpoint: async next => {
			target = zeropsNamespaceTargetCodec.decode(zeropsNamespaceTargetCodec.encode(next))
		},
	})
	return {
		calls,
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

test('started waits for upload and positive build acceptance on the same reserved version', async () => {
	const f = fixture()
	const uploading = Promise.withResolvers<void>()
	const finishUpload = Promise.withResolvers<void>()
	let completed = false
	const work = runZeropsProxyAttempt({
		...f.input(),
		source: {
			...f.source,
			upload: async input => {
				uploading.resolve()
				await finishUpload.promise
				return f.source.upload(input)
			},
		},
	}).then(result => {
		completed = true
		return result
	})
	await uploading.promise
	expect(completed).toBe(false)
	expect(f.calls.some(call => call.startsWith('build:'))).toBe(false)
	finishUpload.resolve()
	const result = await work
	expect(f.calls.filter(call => /reserve:|upload:|build:/.test(call))).toEqual(['reserve:v1', 'upload:v1', 'build:v1'])
	expect(result.proxyBuild?.phase).toBe('build_triggered')
	expect(result.proxyBuild?.manifestSha256).toMatch(/^[a-f0-9]{64}$/)
})

test('ambiguous UPLOADING blocks another invocation across durable roundtrip without retry or deletion', async () => {
	const f = fixture()
	f.status('UPLOADING')
	f.api.buildAndDeployAppVersion = async input => {
		f.calls.push(`build:${input.appVersionId}`)
		throw new Error('response lost')
	}
	await expect(runZeropsProxyAttempt(f.input())).rejects.toThrow('v1 remains unresolved')
	expect(f.target().proxyBuild?.phase).toBe('build_trigger_requested')
	f.calls.length = 0
	await expect(runZeropsProxyAttempt({ ...f.input(), manifest: changedManifest })).rejects.toThrow('v1 remains unresolved')
	expect(f.calls).toEqual(['observe:v1'])
})

test('positive exact-version observation proves started after a lost response', async () => {
	const f = fixture()
	f.status('BUILDING')
	f.api.buildAndDeployAppVersion = async () => {
		throw new Error('response lost')
	}
	const result = await runZeropsProxyAttempt(f.input())
	expect(result.proxyBuild?.appVersionId).toBe('v1')
	expect(result.proxyBuild?.phase).toBe('build_trigger_requested')
	expect(f.calls).not.toContain('delete:v1')
})

test('new manifest intent cannot overwrite an unresolved attempt and is published only after old version settles', async () => {
	const f = fixture()
	f.status('BUILDING')
	const first = await runZeropsProxyAttempt(f.input())
	const priorDigest = first.proxyBuild?.manifestSha256
	const changed = changedManifest
	f.calls.length = 0
	await expect(runZeropsProxyAttempt({ ...f.input(), manifest: changed })).rejects.toThrow('remains unresolved')
	expect(f.calls).toEqual(['observe:v1'])
	f.status('ACTIVE')
	const second = await runZeropsProxyAttempt({ ...f.input(), manifest: changed })
	expect(second.proxyDeployment?.appVersionId).toBe('v1')
	expect(second.proxyDeployment?.manifestSha256).toBe(priorDigest)
	expect(second.proxyBuild?.appVersionId).toBe('v2')
	expect(second.proxyBuild?.manifestSha256).not.toBe(priorDigest)
})

test('source_uploaded retry cannot report a newer manifest started while its old intent is building', async () => {
	const f = fixture()
	await runZeropsProxyAttempt(f.input())
	const target = f.target()
	if (target.proxyBuild === undefined) throw new Error('missing attempt')
	f.status('BUILDING')
	await expect(runZeropsProxyAttempt({
		...f.input(),
		target: { ...target, proxyBuild: { ...target.proxyBuild, phase: 'source_uploaded', processId: undefined } },
		manifest: changedManifest,
	})).rejects.toThrow('remains unresolved')
	expect(f.calls.filter(call => call.startsWith('reserve:'))).toHaveLength(1)
})

test('resolution failure and invalid descriptor digest cause no external writes', async () => {
	const f = fixture()
	await expect(runZeropsProxyAttempt({
		...f.input(),
		source: {
			...f.source,
			resolve: async () => {
				throw new Error('source unavailable')
			},
		},
	})).rejects.toThrow('source unavailable')
	expect(f.calls).toEqual([])
	await expect(
		runZeropsProxyAttempt({
			...f.input(),
			target: { ...f.target(), proxySource: { ...pin, descriptor: { ...pin.descriptor, sha256: '0'.repeat(64) } } },
		}),
	).rejects.toThrow()
	expect(f.calls).toEqual([])
})

test('deployment evidence without a manifest digest never proves current routing', async () => {
	const f = fixture()
	await runZeropsProxyAttempt({ ...f.input(), wait: 'active' })
	const target = f.target()
	if (target.proxyDeployment === undefined) throw new Error('missing deployment')
	const result = await runZeropsProxyAttempt({
		...f.input(),
		target: {
			...target,
			proxyDeployment: { ...target.proxyDeployment, manifestSha256: undefined },
		},
	})
	expect(result.proxyBuild?.appVersionId).toBe('v2')
	expect(f.calls.filter(call => call.startsWith('reserve:'))).toEqual(['reserve:v1', 'reserve:v2'])
})

test('an unpinned legacy target is refused before any source or platform call', async () => {
	const f = fixture()
	await expect(
		runZeropsProxyAttempt({
			...f.input(),
			target: { ...f.target(), proxySource: undefined, proxyBuildFromGit: 'https://github.com/example/platform' },
		}),
	).rejects.toThrow('unpinned')
	expect(f.calls).toEqual([])
})

test('upload failure cancels source before deleting the inert version and never builds', async () => {
	const f = fixture()
	await expect(runZeropsProxyAttempt({
		...f.input(),
		source: {
			...f.source,
			upload: async () => {
				throw new Error('upload failed')
			},
		},
	})).rejects.toThrow('upload failed')
	expect(f.calls.slice(-2)).toEqual(['cancelSource:v1', 'delete:v1'])
	expect(f.calls).not.toContain('build:v1')
	expect(f.target().proxyBuild).toBeUndefined()
})

test('failed source cancellation retains inert checkpoint and refuses deletion', async () => {
	const f = fixture()
	await expect(runZeropsProxyAttempt({
		...f.input(),
		source: {
			...f.source,
			upload: async () => {
				throw new Error('upload failed')
			},
			cancel: async () => {
				throw new Error('cancellation lost')
			},
		},
	})).rejects.toThrow('remains unresolved')
	expect(f.calls).not.toContain('delete:v1')
	expect(f.target().proxyBuild?.phase).toBe('version_created')
})

test('lease loss during upload preserves checkpoint without cancellation, deletion or build', async () => {
	const f = fixture()
	await expect(runZeropsProxyAttempt({
		...f.input(),
		source: {
			...f.source,
			upload: async () => {
				f.controller.abort(new ProviderInvocationAbort('lease_lost'))
				throw f.controller.signal.reason
			},
		},
	})).rejects.toThrow()
	expect(f.calls.some(call => /delete:|cancel|build:/.test(call))).toBe(false)
	expect(f.target().proxyBuild?.phase).toBe('version_created')
})

test('namespace ownership loss wins over an earlier application cancellation during upload', async () => {
	const f = fixture()
	const ownership = new AbortController()
	await expect(runZeropsProxyAttempt({
		...f.input(),
		ownershipSignal: ownership.signal,
		source: {
			...f.source,
			upload: async () => {
				f.controller.abort(new ProviderInvocationAbort('cancel_requested'))
				ownership.abort(new ProviderInvocationAbort('lease_lost'))
				throw f.controller.signal.reason
			},
		},
	})).rejects.toThrow()
	expect(f.calls.some(call => /delete:|cancel|build:/.test(call))).toBe(false)
	expect(f.target().proxyBuild?.phase).toBe('version_created')
})

test('caller cancellation during reservation records its identity and cleans only that inert version', async () => {
	const f = fixture()
	const reserve = f.api.createAppVersion
	f.api.createAppVersion = async input => {
		const result = await reserve(input)
		f.controller.abort(new ProviderInvocationAbort('cancel_requested'))
		return result
	}
	await expect(runZeropsProxyAttempt(f.input())).rejects.toThrow()
	expect(f.target().proxyBuild).toBeUndefined()
	expect(f.calls.slice(-2)).toEqual(['cancelSource:v1', 'delete:v1'])
	expect(f.calls.some(call => /build:|upload:/.test(call))).toBe(false)
})

for (const phase of ['source_uploaded', 'build_trigger_requested']) {
	test(`cancellation during ${phase} checkpoint clears confirmed inert deletion and allows retry`, async () => {
		const f = fixture()
		const ownership = new AbortController()
		const input = f.input()
		await expect(runZeropsProxyAttempt({
			...input,
			ownershipSignal: ownership.signal,
			checkpoint: async next => {
				await input.checkpoint(next)
				if (next.proxyBuild?.phase === phase) f.controller.abort(new ProviderInvocationAbort('cancel_requested'))
			},
		})).rejects.toThrow()
		expect(f.calls.slice(-2)).toEqual(['cancelSource:v1', 'delete:v1'])
		expect(f.calls).not.toContain('build:v1')
		expect(f.target().proxyBuild).toBeUndefined()
		await runZeropsProxyAttempt({ ...f.input(), signal: new AbortController().signal, ownershipSignal: ownership.signal })
		expect(f.target().proxyBuild?.appVersionId).toBe('v2')
		expect(f.calls).toContain('build:v2')
	})
}

test('unconfirmed deletion after checkpoint cancellation retains a recoverable inert checkpoint', async () => {
	const f = fixture()
	const input = f.input()
	f.api.deleteAppVersion = async () => {
		throw new Error('deletion unknown')
	}
	await expect(runZeropsProxyAttempt({
		...input,
		ownershipSignal: new AbortController().signal,
		checkpoint: async next => {
			await input.checkpoint(next)
			if (next.proxyBuild?.phase === 'build_trigger_requested') f.controller.abort(new ProviderInvocationAbort('cancel_requested'))
		},
	})).rejects.toThrow('remains unresolved')
	expect(f.target().proxyBuild?.phase).toBe('version_created')
	expect(f.calls).not.toContain('build:v1')
})

test('lease loss after inert deletion cannot clear the ledger; a new owner can recover the cleanup checkpoint', async () => {
	const f = fixture()
	const ownership = new AbortController()
	const input = f.input()
	const remove = f.api.deleteAppVersion
	f.api.deleteAppVersion = async value => {
		await remove(value)
		ownership.abort(new ProviderInvocationAbort('lease_lost'))
	}
	await expect(runZeropsProxyAttempt({
		...input,
		ownershipSignal: ownership.signal,
		checkpoint: async next => {
			await input.checkpoint(next)
			if (next.proxyBuild?.phase === 'build_trigger_requested') f.controller.abort(new ProviderInvocationAbort('cancel_requested'))
		},
	})).rejects.toThrow()
	expect(f.target().proxyBuild?.phase).toBe('version_created')
	f.api.deleteAppVersion = remove
	await runZeropsProxyAttempt({ ...f.input(), signal: new AbortController().signal, ownershipSignal: new AbortController().signal })
	expect(f.target().proxyBuild?.appVersionId).toBe('v2')
})

test('an explicit IAM rotation cannot report an inherited uploaded attempt as the new configuration', async () => {
	const f = fixture()
	await runZeropsProxyAttempt(f.input())
	const target = f.target()
	if (target.proxyBuild === undefined) throw new Error('missing attempt')
	f.status('BUILDING')
	await expect(runZeropsProxyAttempt({
		...f.input(),
		iamKey: 'rotated-key',
		target: {
			...target,
			proxyBuild: { ...target.proxyBuild, phase: 'source_uploaded', processId: undefined },
		},
	})).rejects.toThrow('remains unresolved')
	f.status('ACTIVE')
	await runZeropsProxyAttempt({ ...f.input(), iamKey: 'rotated-key' })
	expect(f.target().proxyBuild?.appVersionId).toBe('v2')
})

for (const change of ['issuer', 'key', 'unchanged']) {
	test(`explicit ${change} IAM sync activates a fresh version without relying on secret read-back`, async () => {
		const f = fixture()
		await runZeropsProxyAttempt({ ...f.input(), wait: 'active' })
		const input = f.input()
		const iamUrl = change === 'issuer' ? 'https://new-iam.example.test' : input.iamUrl
		const iamKey = change === 'key' ? 'rotated-key' : input.iamKey
		// Even a prewritten desired value is not evidence of what the running version loaded.
		f.api.listServiceEnv = async () => [
			{ id: 'issuer', key: 'FABRIKA_IAM_ISSUER', content: iamUrl },
			{ id: 'key', key: 'FABRIKA_IAM_KEY', content: iamKey },
		]
		f.calls.length = 0
		await runZeropsProxyAttempt({ ...input, iamUrl, iamKey })
		expect(f.calls).toContain('env:FABRIKA_IAM_KEY')
		expect(f.calls).toContain('build:v2')
		expect(f.target().proxyBuild?.appVersionId).toBe('v2')
		expect(JSON.stringify(f.target())).not.toContain(iamKey)
	})
}
