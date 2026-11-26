import { createPage, Link } from '@buzola/router'
import { useEffect, useMemo, useState } from 'react'
import { environmentStateOf, EnvironmentStates, readableEnvironments, useEnvironmentStatesAcross } from '../../components/app/AppFrame'
import { Icon } from '../../components/Icon'
import { SearchField } from '../../components/SearchField'
import { Chip } from '../../components/Status'
import { EmptyState, Table } from '../../components/Table'
import { api, ApiError, type AppDto, type AppEnvDto } from '../../lib/api'
import { mayOpen } from '../../lib/console-access'
import { useConsoleAccess } from '../../lib/console-caller'
import type { EnvironmentState } from '../../lib/environment-state'
import { fmtAgo, fmtDate, shortRef } from '../../lib/format'
import { consoleSession } from '../../lib/session'

// Apps: every registered app, with each environment's state. The detail page (apps/:id) holds its envs, secrets, and per-env Deploy.
// New apps are onboarded at /apps/new; this is the registry view. An application with no deploy target signs people in
// through IAM and is registered in Access (ADR-0089), so adding one starts here too, for the caller who may open that page.

export default createPage()
	.loader(async () => {
		const [apps, session] = await Promise.all([api.apps.list(), consoleSession()])
		return { apps: apps.items, external: mayOpen(session, 'access/external-apps') }
	})
	.route('/apps')
	.render(({ data }) => {
		const [query, setQuery] = useState('')
		const q = query.trim().toLowerCase()
		const filtered = useMemo(
			() => data.apps.filter((app) => q === '' || app.id.toLowerCase().includes(q) || app.repoUrl.toLowerCase().includes(q)),
			[data.apps, q],
		)
		const environments = useApplicationEnvironments(data.apps)
		// A state is a live call to the environment's object: only the rows the search shows are asked.
		const shownEnvs = useMemo(
			() =>
				filtered.flatMap((app) => {
					const read = environments.get(app.id)
					return read?.kind === 'read' ? read.items : []
				}),
			[filtered, environments],
		)
		const states = useEnvironmentStatesAcross(shownEnvs)

		return (
			<>
				<div className="page-head">
					<div className="page-head-row">
						<div>
							<h1>Applications</h1>
							<p className="hint">Every source repository fabrika knows how to build and release.</p>
						</div>
						<Link to="apps/new" className="btn primary">
							<Icon name="plus" />
							New app
						</Link>
						{data.external && (
							<Link to="access/external-apps/new" className="btn" title="An application outside this installation that signs people in through IAM">
								Add external application (no deploy)
							</Link>
						)}
					</div>
				</div>

				<div className="filters">
					<SearchField label="Search" value={query} onChange={setQuery} placeholder="App id or repository" />
					<span className="count">{filtered.length} of {data.apps.length}</span>
				</div>

				<Table
					colSpan={5}
					isEmpty={filtered.length === 0}
					empty={data.apps.length === 0
						? (
							<EmptyState
								icon="app"
								title="No apps registered yet"
								body="Onboarding points fabrika at a repository and places its first environment."
								action={<Link to="apps/new" className="btn small primary">Onboard an app</Link>}
							/>
						)
						: <EmptyState icon="search" title="No apps match" body="Try a different id or repository fragment." />}
					head={
						<tr>
							<th>App</th>
							<th>State</th>
							<th className="grow">Repository</th>
							<th>Default branch</th>
							<th>Registered</th>
						</tr>
					}
				>
					{filtered.map((app) => (
						<tr key={app.id}>
							<td>
								<Link to="apps/detail" params={{ id: app.id }}>
									<strong>{app.id}</strong>
								</Link>
							</td>
							<td>
								<ApplicationStates appId={app.id} read={environments.get(app.id) ?? { kind: 'reading' }} states={states} />
							</td>
							<td>
								<code className="small">{app.repoUrl.replace(/^https?:\/\//, '')}</code>
							</td>
							<td>
								<Chip>
									<Icon name="branch" size={11} />
									{shortRef(`refs/heads/${app.defaultBranch}`)}
								</Chip>
							</td>
							<td className="muted small nowrap" title={fmtDate(app.createdAt)}>{fmtAgo(app.createdAt)}</td>
						</tr>
					))}
				</Table>
			</>
		)
	})

/** One application's environment list as the page has it: each is asked on its own, after the list renders. */
export type EnvironmentsRead =
	| { readonly kind: 'reading' }
	| { readonly kind: 'read'; readonly items: readonly AppEnvDto[] }
	| { readonly kind: 'failed'; readonly reason: 'forbidden' | 'unavailable' }

function useApplicationEnvironments(apps: readonly AppDto[]): ReadonlyMap<string, EnvironmentsRead> {
	const [reads, setReads] = useState<ReadonlyMap<string, EnvironmentsRead>>(new Map())
	useEffect(() => {
		let live = true
		const settle = (appId: string, read: EnvironmentsRead) => {
			if (live) setReads((previous) => new Map(previous).set(appId, read))
		}
		for (const app of apps) {
			void api.apps.environments.list({ appId: app.id }).then(
				(page) => settle(app.id, { kind: 'read', items: page.items }),
				(cause: unknown) =>
					settle(app.id, { kind: 'failed', reason: cause instanceof ApiError && cause.httpStatus === 403 ? 'forbidden' : 'unavailable' }),
			)
		}
		return () => {
			live = false
		}
	}, [apps])
	return reads
}

/** An application's State cell: each environment with its lamp, linked to its Data tab where the caller reads its data. */
export function ApplicationStates({ appId, read, states }: {
	appId: string
	read: EnvironmentsRead
	states: ReadonlyMap<string, EnvironmentState>
}) {
	const access = useConsoleAccess()
	if (read.kind === 'reading') return <span className="muted small">Reading…</span>
	if (read.kind === 'failed') {
		return <span className="muted small">{read.reason === 'forbidden' ? 'Environments not readable' : 'Environments unavailable'}</span>
	}
	if (read.items.length === 0) return <span className="muted small">No environments</span>
	return (
		<EnvironmentStates
			appId={appId}
			envs={read.items}
			readable={readableEnvironments(access, read.items)}
			states={new Map(read.items.map((env) => [env.env, environmentStateOf(states, env)]))}
			label={`Environments of ${appId}`}
		/>
	)
}
