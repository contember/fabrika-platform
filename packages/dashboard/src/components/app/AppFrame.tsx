import { Link } from '@buzola/router'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { type ReactNode, useEffect, useState } from 'react'
import { api, type AppDto, type AppEnvDto } from '../../lib/api'
import { holdsAnywhere, holdsAtApp, mayDo, opensApplications } from '../../lib/console-access'
import { useConsoleAccess } from '../../lib/console-caller'
import { type EnvironmentState, needsDataAttention, readEnvironmentState, stateLabel, stateLamp } from '../../lib/environment-state'
import { Icon } from '../Icon'
import { Status, StatusLamp } from '../Status'

/** The tabs of an application's page, one per task (T1429). */
export type AppTab = 'overview' | 'deploys' | 'data' | 'secrets' | 'access' | 'approvals' | 'settings'

/** What every tab of an application's page reads first: the application and its environments (`app.manage` at the app). */
export async function loadAppFrame(appId: string) {
	const [app, envs] = await Promise.all([api.apps.get({ appId }), api.apps.environments.list({ appId })])
	return { app, envs: envs.items }
}

export type AppFrameData = Awaited<ReturnType<typeof loadAppFrame>>

/**
 * The environment whose Data tab a link opens: the first one whose data needs a person, else `prod` when there is one,
 * else the first. Null without environments.
 */
export function dataTabEnvironment(envs: readonly Pick<AppEnvDto, 'env'>[], states: ReadonlyMap<string, EnvironmentState>): string | null {
	const attention = envs.find((env) => {
		const state = states.get(env.env)
		return state !== undefined && needsDataAttention(state)
	})
	return attention?.env ?? envs.find((env) => env.env === 'prod')?.env ?? envs[0]?.env ?? null
}

// One live read per environment for a while: every tab shows the lamps, and the object's view is a live call to it.
const STATE_TTL_MS = 30_000
const stateReads = new Map<string, { readonly at: number; readonly read: Promise<EnvironmentState> }>()

function cachedState(env: AppEnvDto): Promise<EnvironmentState> {
	const key = `${env.appId}\u0000${env.env}`
	const held = stateReads.get(key)
	if (held !== undefined && Date.now() - held.at < STATE_TTL_MS) return held.read
	const read = readEnvironmentState(api, env)
	stateReads.set(key, { at: Date.now(), read })
	return read
}

/** Each environment's state, read on its own: one that has not answered reads `reading` and blocks nothing. */
export function useEnvironmentStates(envs: readonly AppEnvDto[]): ReadonlyMap<string, EnvironmentState> {
	const [states, setStates] = useState<ReadonlyMap<string, EnvironmentState>>(() => new Map(envs.map((env) => [env.env, { kind: 'reading' }])))
	useEffect(() => {
		let live = true
		setStates(new Map(envs.map((env) => [env.env, { kind: 'reading' }])))
		for (const env of envs) {
			void cachedState(env).then((state) => {
				if (live) setStates((previous) => new Map(previous).set(env.env, state))
			})
		}
		return () => {
			live = false
		}
	}, [envs])
	return states
}

/** Forget the states read so far, after an action that changes one (a maintenance, a recovery). */
export function forgetEnvironmentStates(appId: string) {
	for (const key of [...stateReads.keys()]) if (key.startsWith(`${appId}\u0000`)) stateReads.delete(key)
}

/**
 * An application's page: its head (back link, name, source, each environment's state lamp), the tabs, and the tab's
 * content. A tab the caller holds nothing for is not offered; Control decides every call either way.
 */
export function AppFrame({ app, envs, tab, states, children }: {
	app: AppDto
	envs: readonly AppEnvDto[]
	tab: AppTab
	states: ReadonlyMap<string, EnvironmentState>
	children: ReactNode
}) {
	const access = useConsoleAccess()
	const dataEnv = dataTabEnvironment(envs, states)
	const dataAttention = envs.some((env) => {
		const state = states.get(env.env)
		return state !== undefined && needsDataAttention(state)
	})
	const readsData = access === null || envs.some((env) => mayDo(access, CONTROL_ACTIONS.DATA_READ, { app: app.id, env: env.env }))
	const managesSecrets = access === null || holdsAtApp(access, CONTROL_ACTIONS.SECRET_MANAGE, app.id)
	const readsRuns = access === null || holdsAnywhere(access, CONTROL_ACTIONS.DEPLOY_READ)
	const current = (candidate: AppTab) => (candidate === tab ? 'page' : undefined)

	return (
		<>
			<div className="page-head">
				{opensApplications(access) && (
					<Link to="apps" className="back-link">
						<Icon name="chevron-left" size={14} />
						Applications
					</Link>
				)}
				<div className="page-head-row">
					<h1>{app.id}</h1>
					<ul className="app-env-states" aria-label="Environments">
						{envs.map((env) => {
							const state = states.get(env.env) ?? { kind: 'reading' }
							return (
								<li key={env.env}>
									<Link to="apps/data" params={{ id: app.id, env: env.env }} className="app-env-state" title={`${env.env}: ${stateLabel(state)}`}>
										<strong>{env.env}</strong>
										<Status lamp={stateLamp(state)}>{stateLabel(state)}</Status>
									</Link>
								</li>
							)
						})}
					</ul>
				</div>
				<div className="subtitle">
					<code>{app.repoUrl}</code>
					<span className="dot-sep">
						default branch <code>{app.defaultBranch}</code>
					</span>
				</div>
			</div>
			<nav className="page-tabs" aria-label="Application">
				<Link to="apps/detail" params={{ id: app.id }} aria-current={current('overview')}>Overview</Link>
				{readsRuns && <Link to="apps/deploys" params={{ id: app.id }} aria-current={current('deploys')}>Deploys</Link>}
				{readsData && dataEnv !== null && (
					<Link to="apps/data" params={{ id: app.id, env: dataEnv }} aria-current={current('data')}>
						Data
						{dataAttention && <StatusLamp lamp="stop" />}
					</Link>
				)}
				{managesSecrets && <Link to="apps/secrets" params={{ id: app.id }} aria-current={current('secrets')}>Secrets and variables</Link>}
				<Link to="apps/access" params={{ id: app.id }} aria-current={current('access')}>Access</Link>
				<Link to="apps/approvals" params={{ id: app.id }} aria-current={current('approvals')}>Approvals</Link>
				<Link to="apps/settings" params={{ id: app.id }} aria-current={current('settings')}>Settings</Link>
			</nav>
			{children}
		</>
	)
}
