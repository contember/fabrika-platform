import { createPage, Link, useNavigate } from '@buzola/router'
import { useState } from 'react'
import { BuildConfigSection } from '../../components/app-detail/BuildConfigSection'
import { EnvironmentsSection } from '../../components/app-detail/EnvironmentsSection'
import { AppFrame, loadAppFrame, useEnvironmentStates } from '../../components/app/AppFrame'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Icon } from '../../components/Icon'
import { api, ApiError, type DeploymentNamespaceDto } from '../../lib/api'
import { fmtDate } from '../../lib/format'

// How an application is built and where its environments run. Only this tab reads the namespaces, which an
// application's own manager may not list: the environment form's placement picker needs them.

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => {
		const [frame, namespaces, installation] = await Promise.all([
			loadAppFrame(params.id),
			api.namespaces.list().then((list) => list.items, refusedAsNone),
			api.installation(),
		])
		return { ...frame, namespaces, providerId: installation.provider }
	})
	.route('/apps/:id/settings')
	.render(({ data, invalidate }) => {
		const { app, envs, namespaces, providerId } = data
		const states = useEnvironmentStates(envs)
		const [confirming, setConfirming] = useState(false)
		const navigate = useNavigate()

		async function deleteApp() {
			await api.apps.delete({ appId: app.id })
			navigate('apps')
		}

		return (
			<AppFrame app={app} envs={envs} tab="settings" states={states}>
				<BuildConfigSection app={app} providerId={providerId} onDone={invalidate} />
				<EnvironmentsSection appId={app.id} envs={envs} namespaces={namespaces} providerId={providerId} onDone={invalidate} />
				<section>
					<div className="section-head">
						<h2>Work locally with the builder</h2>
					</div>
					<p>
						Open your checkout of <code>{app.repoUrl}</code>. Run <code>fabrika builder init --url={location.origin}</code> for a new builder project, or
						{' '}
						<code>fabrika builder connect --url={location.origin}</code> to connect an existing one, and select <strong>{app.id}</strong> during approval.
						{' '}
						<Link to="builder/authorize">Connection instructions and your builder keys</Link>
					</p>
				</section>
				<p className="muted small">Registered {fmtDate(app.createdAt)}.</p>
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
			</AppFrame>
		)
	})

/** Listing namespaces needs `namespace.manage` globally; Control's refusal leaves the placement picker empty, an outage throws. */
function refusedAsNone(cause: unknown): DeploymentNamespaceDto[] {
	if (cause instanceof ApiError && (cause.httpStatus === 403 || cause.httpStatus === 404)) return []
	throw cause
}
