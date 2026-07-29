import { defineApp } from '@fabrika/config'
import { compileFabrikaManifest, type DeployDriver } from '@fabrika/engine'
import { describe, expect, test } from 'bun:test'
import { uuidv7 } from '../db'
import type { Env } from '../env'
import { startZeropsRun } from '../services'
import { createHarness } from './helpers/harness'

describe('in-process Zerops control path', () => {
	test('validates the stored manifest and runs the Zerops driver with registry topology', async () => {
		const { db, d1 } = createHarness()
		const manifest = compileFabrikaManifest(
			defineApp({
				id: 'notes',
				pipeline: { vars: ['IMAGE'] },
				target: { platform: 'zerops', services: () => [{ hostname: 'api', type: 'alpine/bun@1.3', buildFromGit: process.env['IMAGE'] }] },
			}),
			'prod',
		)
		await db.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
		await db.upsertAppEnv({
			appId: 'notes',
			env: 'prod',
			platform: 'zerops',
			zeropsProjectId: 'project-1',
			zeropsServiceId: 'service-1',
			manifestJson: JSON.stringify(manifest),
		})
		const runId = uuidv7()
		await db.createRun({ id: runId, appId: 'notes', env: 'prod', ref: 'refs/heads/main', trigger: 'manual' })
		const app = await db.getApp('notes')
		const appEnv = await db.getAppEnv('notes', 'prod')
		const run = await db.getRun(runId)
		if (app === null || appEnv === null || run === null) throw new Error('test seed failed')

		const seen: string[] = []
		const driver: DeployDriver<'zerops'> = {
			id: 'zerops',
			open(input) {
				seen.push(`${input.config.id}:${input.ctx.target.projectId}:${input.ctx.target.serviceId}`)
				seen.push(input.config.target.compiled?.importYaml ?? 'source')
				seen.push(input.ctx.vars?.['IMAGE'] ?? 'missing')
				return Promise.resolve({
					plan: {
						appId: input.config.id,
						env: input.ctx.env,
						steps: [
							{ id: 'apply-import', kind: 'apply-import', description: 'apply' },
							{ id: 'trigger-deploy', kind: 'trigger-deploy', description: 'trigger' },
							{ id: 'await-deploy', kind: 'await-deploy', description: 'await' },
						],
					},
					execute(stepId) {
						seen.push(stepId)
						return Promise.resolve()
					},
				})
			},
		}
		const env: Env = {
			DB: d1,
			ASSETS: { fetch: () => Promise.resolve(new Response()) },
			RUN_LOGS: {
				put: () => Promise.resolve(),
				get: () => Promise.resolve(null),
				delete: () => Promise.resolve(),
			},
			DEPLOY_QUEUE: { send: () => Promise.resolve() },
			ENVIRONMENT: 'prod',
			DEV: 'true',
			ZEROPS_ACCESS_TOKEN: 'secret-token',
		}

		const outcome = await startZeropsRun(env, { app, appEnv, run, vars: { IMAGE: 'registry/image:v1' }, dryRun: false }, {
			drivers: { zerops: driver },
			log: () => {},
			syncProxy: () => Promise.resolve(),
		})
		expect(outcome.status.state).toBe('succeeded')
		expect(seen[0]).toBe('notes:project-1:service-1')
		expect(seen[1]).toContain('${IMAGE}')
		expect(seen[2]).toBe('registry/image:v1')
		expect(seen.slice(3)).toEqual(['apply-import', 'trigger-deploy', 'await-deploy'])
	})
})
