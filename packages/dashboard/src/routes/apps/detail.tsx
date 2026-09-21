import { createPage, Link, useNavigate } from '@buzola/router'
import { useState } from 'react'
import { BuildConfigSection } from '../../components/app-detail/BuildConfigSection'
import { EnvironmentsSection } from '../../components/app-detail/EnvironmentsSection'
import { RecentRunsSection } from '../../components/app-detail/RecentRunsSection'
import { SecretsSection } from '../../components/app-detail/SecretsSection'
import { VariablesSection } from '../../components/app-detail/VariablesSection'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Icon } from '../../components/Icon'
import { api } from '../../lib/api'
import { fmtDate } from '../../lib/format'

// App detail — the per-app registry + operations view: its meta, its environments (each with a
// Deploy button + edit/delete), its secret references (names + layer + vault ref, values never shown),
// and the most recent runs for this app. Add/edit/delete go through the typed registry procedures.

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => {
		const [app, envs, secrets, vars, runs, namespaces] = await Promise.all([
			api.apps.get({ appId: params.id }),
			api.apps.environments.list({ appId: params.id }),
			api.apps.secrets.list({ appId: params.id }),
			api.apps.variables.list({ appId: params.id }),
			api.runs.list({ appId: params.id, limit: 10 }),
			api.namespaces.list(),
		])
		return { app, envs: envs.items, secrets: secrets.items, vars: vars.items, runs: runs.items, namespaces: namespaces.items }
	})
	.route('/apps/:id')
	.render(({ data, invalidate }) => {
		const { app, envs, secrets, vars, runs, namespaces } = data
		const [confirming, setConfirming] = useState(false)
		const navigate = useNavigate()

		async function deleteApp() {
			await api.apps.delete({ appId: app.id })
			navigate('apps')
		}

		return (
			<>
				<div className="page-head">
					<Link to="apps" className="back-link">
						<Icon name="chevron-left" size={14} />
						All applications
					</Link>
					<h1>{app.id}</h1>
					<div className="subtitle">
						<code>{app.repoUrl}</code>
						<span className="dot-sep">
							default branch <code>{app.defaultBranch}</code>
						</span>
						<span className="dot-sep">created {fmtDate(app.createdAt)}</span>
					</div>
				</div>

				<BuildConfigSection app={app} onDone={invalidate} />
				<EnvironmentsSection appId={app.id} envs={envs} namespaces={namespaces} onDone={invalidate} />
				<SecretsSection appId={app.id} secrets={secrets} envs={envs} onDone={invalidate} />
				<VariablesSection appId={app.id} vars={vars} envs={envs} onDone={invalidate} />
				<RecentRunsSection runs={runs} />

				{
					/* Past everything you might have come here to do — not in the page head, where every other
				    screen puts its constructive CTA. */
				}
				<div className="danger-zone">
					<div className="danger-zone-copy">
						<strong>Delete this app</strong>
						Removes its environments and secret references. Run history is kept.
					</div>
					<span className="spacer" />
					<button type="button" className="danger" onClick={() => setConfirming(true)}>
						<Icon name="trash" size={14} />
						Delete app
					</button>
				</div>
				{confirming && (
					<ConfirmDialog
						title="Delete app"
						confirmLabel="Delete app"
						body={
							<p>
								Delete app <strong>{app.id}</strong> and all its environments and secrets? Run history is kept.
							</p>
						}
						onConfirm={deleteApp}
						onClose={() => setConfirming(false)}
					/>
				)}
			</>
		)
	})
