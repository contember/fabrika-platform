// A run list's duration cell says in words what an unfinished run waits for, and offers its review to an approver.

import { buildRouteTree, createMemoryNavigationAdapter, Router } from '@buzola/router'
import { BuzolaProvider } from '@buzola/router/react'
import type { ConsoleAccessDto, RunDto } from '@fabrika/control-contract'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { RunDuration, RunReview } from '../components/RunDuration'
import { ConsoleAccessContext } from '../lib/console-caller'
import approvalPage from '../routes/approvals/detail'

const render = (run: Pick<RunDto, 'id' | 'appId' | 'env' | 'status' | 'startedAt' | 'finishedAt'>, access: ConsoleAccessDto | null = null): string =>
	renderToStaticMarkup(
		<BuzolaProvider
			router={new Router({
				routes: buildRouteTree([{ path: '/', component: () => null, isIndex: true }]),
				adapter: createMemoryNavigationAdapter(),
				pageRegistry: { 'approvals/detail': approvalPage.route },
			})}
		>
			<ConsoleAccessContext.Provider value={access}>
				<RunDuration run={run} />|<RunReview run={run} />
			</ConsoleAccessContext.Provider>
		</BuzolaProvider>,
	)

const run = (status: RunDto['status'], startedAt: number | null = null, finishedAt: number | null = null) => ({
	id: 'run-1',
	appId: 'notes',
	env: 'prod',
	status,
	startedAt,
	finishedAt,
})

describe("a run list's duration and review", () => {
	test('a waiting run reads "Waiting" and offers its review beside the status only to who may decide it there', () => {
		const approver = render(run('awaiting_approval', 100))
		expect(approver).toStartWith('Waiting|')
		expect(approver).toContain('href="/approvals/run-1"')
		expect(approver).not.toContain('none')
		const approverOfProd: ConsoleAccessDto = {
			principal: null,
			global: [],
			scopes: [{ type: 'environment', value: 'prod', actions: ['access.approve'] }],
		}
		expect(render(run('awaiting_approval', 100), approverOfProd)).toContain('href="/approvals/run-1"')
		const approverOfTest: ConsoleAccessDto = {
			principal: null,
			global: [],
			scopes: [{ type: 'environment', value: 'test', actions: ['access.approve'] }],
		}
		expect(render(run('awaiting_approval', 100), approverOfTest)).toBe('Waiting|')
		const reader: ConsoleAccessDto = { principal: null, global: ['deploy.read'], scopes: [] }
		expect(render(run('awaiting_approval', 100), reader)).toBe('Waiting|')
	})

	test('an unfinished run says so in words; a finished one shows its duration', () => {
		expect(render(run('pending'))).toBe('Not started|')
		expect(render(run('running', 100))).toBe('Running|')
		expect(render(run('succeeded', 100, 172))).toBe('1m 12s|')
		expect(render(run('failed'))).toBe('Did not start|')
	})
})
