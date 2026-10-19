// The hourly `overdue` job over more than one page of tasks, and its retry after an attempt times out halfway: the tasks
// the first attempt committed are not marked again, so every task's version moves exactly once.

import { createClient } from '@fabrika/app/client'
import { testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { afterAll, expect, test } from 'bun:test'
import { contract } from '../../../fabrika.contract'
import app from '../../app'

const postgres = await testDatabase({ migrations: new URL('../../../db/migrations/', import.meta.url), label: 'overdue.test.ts' })

/** More than the job's page of 100, so the run takes a second page. */
const TASKS = 130
/** The job's `limits: { timeoutMs: 300000 }`. */
const TIMEOUT_MS = 300_000

if (postgres !== null) {
	afterAll(() => postgres.close())
	const kit = testKit(app, { database: postgres.database, files: new MemoryFileObjects() })
	const acme = kit.scope('org', 'acme')
	const api = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ role: 'sales', scope: acme }])) })
	const manager = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ role: 'manager', scope: acme }])) })

	const allTasks = async () => {
		const items = []
		let after: string | undefined
		do {
			const page = await api.tasks.list({ after })
			items.push(...page.items)
			after = page.next ?? undefined
		} while (after !== undefined)
		return items
	}

	const overdueCount = async () => (await allTasks()).filter((task) => task.overdue).length

	/**
	 * The first attempt times out as soon as it has committed a task: its clock's deadline fires then, and the runner
	 * fences off whatever that attempt still has in flight. Later deadlines wait for their attempt; a backoff is instant.
	 */
	const timingOutOnce = () => {
		let deadlines = 0
		let committedBeforeTimeout = 0
		const clock = {
			random: () => 0,
			wait: async (ms: number, signal: AbortSignal): Promise<void> => {
				if (ms < TIMEOUT_MS) return
				deadlines++
				if (deadlines === 1) {
					while (!signal.aborted && (committedBeforeTimeout = await overdueCount()) === 0) await Bun.sleep(2)
					return
				}
				await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
			},
		}
		return { clock, committedBeforeTimeout: () => committedBeforeTimeout }
	}

	test('every overdue task of every page is marked once, and a retry after a failed attempt marks none twice', async () => {
		const { id: companyId } = await manager.companies.create({ orgId: 'acme', name: 'Backlog Inc' })
		const { id: dealId } = await api.deals.create({ companyId, title: 'Backlog', value: 1 })
		for (let start = 0; start < TASKS; start += 26) {
			const titles = Array.from({ length: Math.min(26, TASKS - start) }, (_, index) => `Late ${start + index}`)
			await Promise.all(titles.map((title) => api.tasks.create({ dealId, title, dueOn: '2020-01-01' })))
		}
		expect(await allTasks()).toHaveLength(TASKS)
		const run = timingOutOnce()
		expect(await kit.runJob('overdue', { clock: run.clock })).toEqual({ status: 'succeeded', attempts: 2 })
		expect(run.committedBeforeTimeout()).toBeGreaterThan(0)
		expect(run.committedBeforeTimeout()).toBeLessThan(TASKS)
		const marked = await allTasks()
		expect(marked.filter((task) => !task.overdue)).toEqual([])
		expect(new Set(marked.map((task) => task.version))).toEqual(new Set([2]))

		expect(await kit.runJob('overdue')).toEqual({ status: 'succeeded', attempts: 1 })
		expect(new Set((await allTasks()).map((task) => task.version))).toEqual(new Set([2]))
	})
}
