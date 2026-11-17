// A succeeded run offers "Deploy again" to a caller who may deploy there: a new run of the same commit (ADR-0050 §6).

import { buildRouteTree, createMemoryNavigationAdapter, Router } from '@buzola/router'
import { BuzolaProvider } from '@buzola/router/react'
import { describe, expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
	type AppEnvDto,
	type AppEnvKind,
	type ConsoleAccessDto,
	type ControlFetch,
	createControlClient,
	type RunDto,
	type RunStatus,
} from '../lib/api'
import { ConsoleAccessContext } from '../lib/console-caller'
import { deployAgain, DeployAgainDialog, RunActions } from '../routes/runs/detail'

const SHA = 'abc1234'.padEnd(40, 'f')

const run = (status: RunStatus, overrides: Partial<RunDto> = {}): RunDto => ({
	id: '01a15abc-0000-7000-8000-000000000000',
	appId: 'notes',
	env: 'prod',
	ref: 'refs/heads/main',
	commitSha: SHA,
	trigger: 'manual',
	actor: null,
	status,
	exitCode: status === 'succeeded' ? 0 : null,
	externalRunId: null,
	logKey: null,
	createdAt: 1,
	startedAt: 1,
	finishedAt: null,
	cancelRequestedAt: null,
	...overrides,
})

const environment = (kind: AppEnvKind): AppEnvDto => ({
	appId: 'notes',
	env: 'prod',
	kind,
	domain: null,
	publicOrigin: null,
	crossOrigins: [],
	triggerRef: 'refs/heads/main',
	authoring: false,
	protected: true,
	publishedRunId: null,
	deviationSubjects: [],
	surface: [],
	namespaceId: null,
	provider: 'zerops',
	target: { provider: 'zerops', version: 1, payload: {} },
	artifact: { provider: 'zerops', version: 1, payload: {} },
	createdAt: 0,
})

const holding = (global: string[], scope?: { type: 'app' | 'environment'; value: string; actions: string[] }): ConsoleAccessDto => ({
	principal: null,
	global,
	scopes: scope === undefined ? [] : [scope],
})

// The button reaches for the router to open the new run; a memory adapter keeps that out of the DOM.
const withRouter = (element: ReactElement): ReactElement => (
	<BuzolaProvider
		router={new Router({
			routes: buildRouteTree([{ path: '/', component: () => null, isIndex: true }]),
			adapter: createMemoryNavigationAdapter(),
			pageRegistry: {},
		})}
	>
		{element}
	</BuzolaProvider>
)

const actions = (subject: RunDto, access: ConsoleAccessDto | null, appEnv: AppEnvDto | null = environment('standard')): string =>
	renderToStaticMarkup(withRouter(
		<ConsoleAccessContext.Provider value={access}>
			<RunActions run={subject} appEnv={appEnv} onDone={() => undefined} />
		</ConsoleAccessContext.Provider>,
	))

describe('deploy again on the run detail', () => {
	test('a succeeded run offers it to a caller who may deploy at its environment', () => {
		expect(actions(run('succeeded'), holding(['deploy.trigger']))).toContain('Deploy again</button>')
		expect(actions(run('succeeded'), holding([], { type: 'environment', value: 'prod', actions: ['deploy.trigger'] }))).toContain('Deploy again')
		expect(actions(run('succeeded'), holding([], { type: 'app', value: 'notes', actions: ['deploy.trigger'] }))).toContain('Deploy again')
	})

	test('a failed, running or commitless run does not offer it', () => {
		const deployer = holding(['deploy.trigger'])
		expect(actions(run('failed'), deployer)).not.toContain('Deploy again')
		expect(actions(run('running'), deployer)).not.toContain('Deploy again')
		expect(actions(run('succeeded', { commitSha: null }), deployer)).not.toContain('Deploy again')
	})

	test('a caller without deploy.trigger at the run, or holding it elsewhere, is not offered it', () => {
		expect(actions(run('succeeded'), holding(['deploy.read']))).not.toContain('Deploy again')
		expect(actions(run('succeeded'), holding([], { type: 'environment', value: 'staging', actions: ['deploy.trigger'] }))).not.toContain('Deploy again')
		expect(actions(run('succeeded'), holding([], { type: 'app', value: 'other', actions: ['deploy.trigger'] }))).not.toContain('Deploy again')
	})

	test('a run of a dev or a deleted environment does not offer it, because Control refuses that deploy', () => {
		const deployer = holding(['deploy.trigger'])
		expect(actions(run('succeeded'), deployer, environment('dev'))).not.toContain('Deploy again')
		expect(actions(run('succeeded'), deployer, null)).not.toContain('Deploy again')
	})

	test('the confirmation names the short commit and the environment', () => {
		const html = renderToStaticMarkup(<DeployAgainDialog env="prod" commitSha={SHA} onConfirm={async () => undefined} onClose={() => undefined} />)
		expect(html).toContain('role="dialog"')
		expect(html).toContain('Deploy commit <code>abc1234</code> to <strong>prod</strong> again? It replaces what runs there now.')
		expect(html).toContain('Deploy again</button>')
	})

	test('confirming deploys the run commit to the same environment as a new run', async () => {
		const calls: unknown[] = []
		const fetcher: ControlFetch = async (_input, init) => {
			if (typeof init?.body !== 'string') throw new Error('expected JSON RPC body')
			calls.push(JSON.parse(init.body))
			return Response.json({ result: run('pending', { id: 'next-run', commitSha: null, ref: SHA }) })
		}
		const next = await deployAgain(createControlClient(fetcher), { appId: 'notes', env: 'prod', commitSha: SHA })
		expect(next.id).toBe('next-run')
		expect(calls).toEqual([{ method: 'deploy', input: { appId: 'notes', env: 'prod', ref: SHA } }])
	})

	test('a refusal rejects with the server message, which the dialog shows', async () => {
		const fetcher: ControlFetch = async () => Response.json({ error: { type: 'error', message: 'refused' } }, { status: 403 })
		await expect(deployAgain(createControlClient(fetcher), { appId: 'notes', env: 'prod', commitSha: SHA })).rejects.toThrow('refused')
	})
})
