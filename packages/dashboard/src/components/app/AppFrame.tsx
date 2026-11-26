import { Link } from '@buzola/router'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { api, type AppDto, type AppEnvDto, type ConsoleAccessDto } from '../../lib/api'
import { holdsAtApp, mayDo, opensApplications } from '../../lib/console-access'
import { useConsoleAccess } from '../../lib/console-caller'
import { type EnvironmentState, needsDataAttention, readEnvironmentState, stateLabel, stateLamp } from '../../lib/environment-state'
import { Icon } from '../Icon'
import { Status, StatusLamp } from '../Status'

/** The tabs of an application's page, one per task. */
export type AppTab = 'overview' | 'deploys' | 'data' | 'secrets' | 'access' | 'approvals' | 'settings'

/** What every tab of an application's page reads first: the application and its environments (`app.manage` at the app). */
export async function loadAppFrame(appId: string) {
	const [app, envs] = await Promise.all([api.apps.get({ appId }), api.apps.environments.list({ appId })])
	return { app, envs: envs.items }
}

export type AppFrameData = Awaited<ReturnType<typeof loadAppFrame>>

/**
 * The environment whose Data tab a link opens, among those the caller reads: the first whose data needs a person, else
 * `prod` when there is one, else the first. Null without one.
 */
export function dataTabEnvironment(envs: readonly Pick<AppEnvDto, 'env'>[], states: ReadonlyMap<string, EnvironmentState>): string | null {
	const attention = envs.find((env) => {
		const state = states.get(env.env)
		return state !== undefined && needsDataAttention(state)
	})
	return attention?.env ?? envs.find((env) => env.env === 'prod')?.env ?? envs[0]?.env ?? null
}

/** The environment the Access tab opens on: `prod` when there is one, else the first. Null without one. */
export function accessTabEnvironment(envs: readonly Pick<AppEnvDto, 'env'>[]): string | null {
	return envs.find((env) => env.env === 'prod')?.env ?? envs[0]?.env ?? null
}

/** The environments whose data the caller may read; Control decides each read either way. */
export function readableEnvironments<T extends Pick<AppEnvDto, 'appId' | 'env'>>(access: ConsoleAccessDto | null, envs: readonly T[]): T[] {
	return envs.filter((env) => mayDo(access, CONTROL_ACTIONS.DATA_READ, { app: env.appId, env: env.env }))
}

// One live read per environment for a while: every tab shows the lamps, and the object's view is a live call to it.
const STATE_TTL_MS = 30_000
interface HeldState {
	/** Publishing or suspending changes what Control reports, so a held read is good only for the same facts. */
	readonly facts: string
	readonly at: number
	readonly read: Promise<EnvironmentState>
	settled: EnvironmentState | null
}
const stateReads = new Map<string, HeldState>()

/** An environment's key among several applications' environments: its name alone repeats across applications. */
export const environmentKey = (appId: string, env: string) => `${appId}\u0000${env}`
const factsOf = (env: AppEnvDto) => `${env.publishedRunId ?? ''}\u0000${env.suspendedAt ?? ''}`

function current(env: AppEnvDto): HeldState | null {
	const held = stateReads.get(environmentKey(env.appId, env.env))
	return held !== undefined && held.facts === factsOf(env) && Date.now() - held.at < STATE_TTL_MS ? held : null
}

function heldState(env: AppEnvDto): HeldState {
	const held = current(env)
	if (held !== null) return held
	const entry: HeldState = { facts: factsOf(env), at: Date.now(), read: readEnvironmentState(api, env), settled: null }
	void entry.read.then((state) => {
		entry.settled = state
	})
	stateReads.set(environmentKey(env.appId, env.env), entry)
	return entry
}

/** What the lamps show before this render's reads answer: a held answer, else the last one shown, else `reading`. */
function shownStates(
	access: ConsoleAccessDto | null,
	envs: readonly AppEnvDto[],
	previous: ReadonlyMap<string, EnvironmentState>,
): ReadonlyMap<string, EnvironmentState> {
	return new Map(envs.map((env): [string, EnvironmentState] => {
		const key = environmentKey(env.appId, env.env)
		if (!mayDo(access, CONTROL_ACTIONS.DATA_READ, { app: env.appId, env: env.env })) return [key, { kind: 'unknown', reason: 'not-allowed' }]
		return [key, current(env)?.settled ?? previous.get(key) ?? { kind: 'reading' }]
	}))
}

/**
 * Each environment's state, of one application or several, keyed by `environmentKey`: one that has not answered keeps
 * what was shown, or reads `reading`, and blocks nothing. An environment the caller may not read data in is not asked.
 */
export function useEnvironmentStatesAcross(envs: readonly AppEnvDto[]): ReadonlyMap<string, EnvironmentState> {
	const access = useConsoleAccess()
	const [states, setStates] = useState(() => shownStates(access, envs, new Map()))
	useEffect(() => {
		let live = true
		setStates((previous) => shownStates(access, envs, previous))
		for (const env of readableEnvironments(access, envs)) {
			void heldState(env).read.then((state) => {
				if (live) setStates((previous) => new Map(previous).set(environmentKey(env.appId, env.env), state))
			})
		}
		return () => {
			live = false
		}
	}, [envs, access])
	return states
}

/** An environment's state from `useEnvironmentStatesAcross`; `reading` until it is in the map. */
export function environmentStateOf(states: ReadonlyMap<string, EnvironmentState>, env: Pick<AppEnvDto, 'appId' | 'env'>): EnvironmentState {
	return states.get(environmentKey(env.appId, env.env)) ?? { kind: 'reading' }
}

/** One application's environments' states, keyed by environment name. */
export function useEnvironmentStates(envs: readonly AppEnvDto[]): ReadonlyMap<string, EnvironmentState> {
	const states = useEnvironmentStatesAcross(envs)
	return useMemo(() => new Map(envs.map((env) => [env.env, environmentStateOf(states, env)])), [envs, states])
}

/** Forget an environment's held state, after an action or a poll that may have changed it. */
export function forgetEnvironmentState(appId: string, env: string) {
	stateReads.delete(environmentKey(appId, env))
}

/** Each environment's name and state lamp, linked to its Data tab where the caller reads its data; `states` by name. */
export function EnvironmentStates({ appId, envs, readable, states, label }: {
	appId: string
	envs: readonly AppEnvDto[]
	readable: readonly AppEnvDto[]
	states: ReadonlyMap<string, EnvironmentState>
	label: string
}) {
	return (
		<ul className="app-env-states" aria-label={label}>
			{envs.map((env) => {
				const state = states.get(env.env) ?? { kind: 'reading' }
				const content = (
					<>
						<strong>{env.env}</strong>
						<Status lamp={stateLamp(state)}>{stateLabel(state)}</Status>
					</>
				)
				return (
					<li key={env.env}>
						{readable.includes(env)
							? (
								<Link to="apps/data" params={{ id: appId, env: env.env }} className="app-env-state" title={`Open the data of ${env.env}`}>
									{content}
									<span className="sr-only">, open its data</span>
								</Link>
							)
							: <span className="app-env-state">{content}</span>}
					</li>
				)
			})}
		</ul>
	)
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
	const readable = readableEnvironments(access, envs)
	const dataEnv = dataTabEnvironment(readable, states)
	const accessEnv = accessTabEnvironment(envs)
	const dataAttention = readable.some((env) => {
		const state = states.get(env.env)
		return state !== undefined && needsDataAttention(state)
	})
	// Listing an application's runs takes `deploy.read` globally or at the application, not at one environment.
	const readsRuns = access === null || holdsAtApp(access, CONTROL_ACTIONS.DEPLOY_READ, app.id)
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
					<EnvironmentStates appId={app.id} envs={envs} readable={readable} states={states} label="Environments" />
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
				{dataEnv !== null && (
					<Link to="apps/data" params={{ id: app.id, env: dataEnv }} aria-current={current('data')}>
						Data
						{dataAttention && (
							<>
								<StatusLamp lamp="stop" />
								<span className="sr-only">: needs attention</span>
							</>
						)}
					</Link>
				)}
				<Link to="apps/secrets" params={{ id: app.id }} aria-current={current('secrets')}>Secrets and variables</Link>
				{accessEnv === null
					? <Link to="apps/access-default" params={{ id: app.id }} aria-current={current('access')}>Access</Link>
					: <Link to="apps/access" params={{ id: app.id, env: accessEnv }} aria-current={current('access')}>Access</Link>}
				<Link to="apps/approvals" params={{ id: app.id }} aria-current={current('approvals')}>Approvals</Link>
				<Link to="apps/settings" params={{ id: app.id }} aria-current={current('settings')}>Settings</Link>
			</nav>
			{children}
		</>
	)
}
