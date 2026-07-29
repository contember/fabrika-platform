import type { ZeropsAppVersion } from '@fabrika/engine'
import { describe, expect, test } from 'bun:test'
import { reconcileZeropsRuns } from '../zerops-reconcile'
import { createHarness } from './helpers/harness'

describe('reconcileZeropsRuns', () => {
	test('finishes terminal versions and leaves pending platform work untouched', async () => {
		const { db } = createHarness()
		await db.createApp({ id: 'app', repoUrl: 'github.com/o/app' })
		await db.upsertAppEnv({
			appId: 'app',
			env: 'prod',
			platform: 'zerops',
			zeropsProjectId: 'project',
			zeropsServiceId: 'service',
			manifestJson: '{}',
		})

		for (const id of ['active', 'failed', 'building', 'waiting']) {
			await db.createRun({
				id,
				appId: 'app',
				env: 'prod',
				ref: 'refs/heads/main',
				trigger: 'manual',
			})
		}
		for (const id of ['active', 'failed', 'building']) {
			await db.markRunStarted(id, `runs/${id}/logs.ndjson`)
			await db.setRunPlatformId(id, id)
		}

		const versions: Record<string, ZeropsAppVersion> = {
			active: { id: 'active', status: 'ACTIVE' },
			failed: { id: 'failed', status: 'BUILD_FAILED' },
			building: { id: 'building', status: 'BUILDING' },
		}
		const released: string[] = []
		const summary = await reconcileZeropsRuns({
			database: db,
			api: {
				getAppVersion: ({ appVersionId }) => {
					const version = versions[appVersionId]
					if (version === undefined) {
						return Promise.reject(new Error(`unexpected app version ${appVersionId}`))
					}
					return Promise.resolve(version)
				},
			},
			releaseLock: (key, holder) => {
				released.push(`${key}/${holder}`)
				return Promise.resolve()
			},
		})

		expect(summary).toEqual({
			checked: 3,
			succeeded: 1,
			failed: 1,
			inProgress: 1,
			waiting: 1,
		})
		expect((await db.getRun('active'))?.status).toBe('succeeded')
		expect((await db.getRun('failed'))?.status).toBe('failed')
		expect((await db.getRun('building'))?.status).toBe('running')
		expect((await db.getRun('waiting'))?.status).toBe('pending')
		expect(released).toEqual(['app:prod/active', 'app:prod/failed'])
	})

	test('requires a token-backed API only after an app-version id is persisted', async () => {
		const { db } = createHarness()
		await db.createApp({ id: 'app', repoUrl: 'github.com/o/app' })
		await db.upsertAppEnv({ appId: 'app', env: 'prod', platform: 'zerops' })
		await db.createRun({
			id: 'waiting',
			appId: 'app',
			env: 'prod',
			ref: 'refs/heads/main',
			trigger: 'manual',
		})

		expect(
			await reconcileZeropsRuns({
				database: db,
				releaseLock: () => Promise.resolve(),
			}),
		).toEqual({
			checked: 0,
			succeeded: 0,
			failed: 0,
			inProgress: 0,
			waiting: 1,
		})

		await db.markRunStarted('waiting', 'runs/waiting/logs.ndjson')
		await db.setRunPlatformId('waiting', 'version')
		await expect(reconcileZeropsRuns({
			database: db,
			releaseLock: () => Promise.resolve(),
		})).rejects.toThrow('ZEROPS_ACCESS_TOKEN is not configured')
	})
})
