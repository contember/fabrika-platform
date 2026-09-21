import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, integrationFixture, integrationSource } from './helpers/builder-platform-integration'

test('real daemon pairs through IAM and Control, completes two scoped exact-source deployments, and loses access after revocation', async () => {
	const f = await integrationFixture()
	try {
		const sha = integrationSource(f)
		const pairing = (await f.local('connect', { controlOrigin: f.origin })).pairing
		if (pairing?.status !== 'pending') throw new Error('Expected pending pairing')
		const url = new URL(pairing.authorizationUrl)
		const fragment = new URLSearchParams(url.hash.slice(1))
		const proof = { attemptId: fragment.get('attempt'), approvalVerifier: fragment.get('approval') }
		expect(
			(await f.rpc('builderConnections.createReceipt', {
				...proof,
				appId: 'sample',
				environment: { env: 'dev', namespaceId: 'integration-dev', domain: null, publicOrigin: null, triggerRef: 'main' },
			})).status,
		).toBe(200)
		expect((await f.rpc('builderPairing.approve', proof)).status).toBe(200)
		for (let i = 0; i < 100 && !(await f.local('platform')).credential.available; i++) await Bun.sleep(100)
		expect((await f.local('platform')).pairing?.status).toBe('connected')
		const credential = f.storage.credential(f.id)
		if (!credential) throw new Error('Missing redeemed credential')
		expect((await f.rpc('apps.get', { appId: 'sample' }, credential.token)).status).toBe(200)
		expect((await f.rpc('apps.get', { appId: 'other' }, credential.token)).status).toBe(403)
		expect((await f.rpc('apps.get', { appId: 'other' })).status).toBe(403)
		expect((await f.rpc('builderPairing.approve', proof, credential.token)).status).toBe(403)
		await f.local('deploy', {})
		for (let i = 0; i < 100 && f.jobs.length === 0; i++) {
			if ((await f.local('platform')).deployment?.status === 'failed') break
			await Bun.sleep(100)
		}
		expect((await f.local('platform')).deployment?.status).toBe('pending')
		expect(f.jobs).toHaveLength(1)
		const job = f.jobs[0]
		if (!job || !('runId' in job)) throw new Error('Expected deploy job')
		expect(await f.control.repositories.runs.getRun(job.runId)).toMatchObject({ app_id: 'sample', env: 'dev', ref: sha, status: 'pending' })
		expect(await f.control.repositories.registry.listAppEnvs('sample')).toHaveLength(1)
		expect(await f.control.repositories.registry.listAppEnvs('other')).toHaveLength(0)
		expect(await f.consume(job)).toMatchObject({ kind: 'deploy', status: 'succeeded' })
		for (let i = 0; i < 100 && (await f.local('platform')).deployment?.status !== 'succeeded'; i++) await Bun.sleep(100)
		expect((await f.local('platform')).deployment).toMatchObject({ status: 'succeeded', commitSha: sha, runId: job.runId })
		const first = f.deployments[0]
		if (!first) throw new Error('Provider was not invoked')
		expect(first.app.source.ref).toBe(sha)
		const placement = {
			namespaceId: 'integration-dev',
			domain: 'updated.example.test',
			publicOrigin: 'https://updated.example.test',
			triggerRef: 'release',
		}
		expect(
			(await f.rpc('apps.environments.put', {
				appId: 'sample',
				env: 'dev',
				environment: { ...placement, target: first.environment.target, artifact: first.environment.artifact },
			})).status,
		).toBe(200)
		writeFileSync(join(f.root, 'second.ts'), 'export const revision = 2\n')
		git(f.root, 'add', 'second.ts')
		git(f.root, 'commit', '-m', 'second test revision')
		git(f.root, 'push', 'origin', 'HEAD:main')
		const secondSha = git(f.root, 'rev-parse', 'HEAD')
		expect(secondSha).not.toBe(sha)
		await f.local('deploy', {})
		for (let i = 0; i < 100 && f.jobs.length < 2; i++) await Bun.sleep(100)
		expect(f.jobs).toHaveLength(2)
		const secondJob = f.jobs[1]
		if (!secondJob || !('runId' in secondJob)) throw new Error('Missing second deploy job')
		expect(await f.consume(secondJob)).toMatchObject({ kind: 'deploy', status: 'succeeded' })
		for (let i = 0; i < 100 && (await f.local('platform')).deployment?.status !== 'succeeded'; i++) await Bun.sleep(100)
		expect((await f.local('platform')).deployment).toMatchObject({
			status: 'succeeded',
			commitSha: secondSha,
			runId: secondJob.runId,
			appUrl: 'https://updated.example.test/',
		})
		expect(f.deployments).toHaveLength(2)
		expect(f.deployments[1]?.app.source.ref).toBe(secondSha)
		expect(await f.control.repositories.registry.listAppEnvs('sample')).toMatchObject([{
			namespace_id: placement.namespaceId,
			domain: placement.domain,
			public_origin: placement.publicOrigin,
			trigger_ref: placement.triggerRef,
		}])
		if (!proof.attemptId) throw new Error('Missing attempt ID')
		const issued = await f.iam.repositories.device.get(proof.attemptId)
		if (!issued?.credential_id) throw new Error('Missing issued credential ID')
		expect((await f.rpc('builderPairing.revoke', { credentialId: issued.credential_id })).status).toBe(200)
		const mints = f.paths.filter((path) => path === '/auth/mint/key').length
		expect((await f.rpc('apps.get', { appId: 'sample' }, credential.token)).status).toBe(401)
		expect(f.paths.filter((path) => path === '/auth/mint/key')).toHaveLength(mints + 1)
		for (
			const path of [
				'/auth/device/start',
				'/auth/device/poll',
				'/auth/device/exchange',
				'/rpc/inspectDeviceAuthorization',
				'/rpc/approveDeviceAuthorization',
				'/auth/mint/session',
				'/auth/mint/key',
			]
		) expect(f.paths).toContain(path)
	} finally {
		await f.close()
	}
}, 30_000)
