// A run list's duration cell says in words what an unfinished run waits for, and offers its review to an approver.

import { buildRouteTree, createMemoryNavigationAdapter, Router } from '@buzola/router'
import { BuzolaProvider } from '@buzola/router/react'
import type { ConsoleAccessDto, RunDto } from '@fabrika/control-contract'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { RunDuration } from '../components/RunDuration'
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
				<RunDuration run={run} />
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

describe('a run list duration cell', () => {
	test('a run waiting for approval links its review for an approver, and says it waits for anyone else', () => {
		const approver = render(run('awaiting_approval', 100))
		expect(approver).toContain('href="/approvals/run-1"')
		expect(approver).toContain('Review')
		expect(approver).not.toContain('none')
		const reader: ConsoleAccessDto = { principal: null, global: ['deploy.read'], scopes: [] }
		expect(render(run('awaiting_approval', 100), reader)).toBe('Waits for approval')
	})

	test('an unfinished run says so in words; a finished one shows its duration', () => {
		expect(render(run('pending'))).toBe('Not started')
		expect(render(run('running', 100))).toBe('Running')
		expect(render(run('succeeded', 100, 172))).toBe('1m 12s')
	})
})
