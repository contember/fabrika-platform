import { createPage, Link, useNavigate } from '@buzola/router'
import { useState } from 'react'
import { ExternalAppForm } from '../../../access/components/ExternalAppForm'
import { api } from '../../../access/lib/api'
import { ConfirmDialog } from '../../../components/ConfirmDialog'
import { Icon } from '../../../components/Icon'
import { fmtDate } from '../../../lib/format'

/**
 * One external application, edited whole: a save replaces its record, roles and clients at once (ADR-0089). Its id is
 * fixed. People get its roles in Users, as any other application's.
 */
export default createPage()
	.params({ app: 'string' })
	.loader(async ({ params }) => ({ app: await api.externalApps.get({ app: params.app }) }))
	.route('/access/external-apps/:app')
	.render(({ data, invalidate }) => {
		const { app } = data
		const navigate = useNavigate()
		const [confirming, setConfirming] = useState(false)
		const [saved, setSaved] = useState(false)
		const title = app.name ?? app.app

		async function remove() {
			await api.externalApps.delete({ app: app.app })
			navigate('access/external-apps')
		}

		return (
			<>
				<div className="page-head">
					<Link to="access/external-apps" className="back-link">
						<Icon name="chevron-left" size={14} />
						All external applications
					</Link>
					<h1>{title}</h1>
					<div className="subtitle">
						<code>{app.app}</code>
						<span className="dot-sep">changed {fmtDate(app.updatedAt)}</span>
					</div>
				</div>

				{saved && <p className="notice" role="status">Saved. The next sign-in, code exchange or token refresh uses it.</p>}
				<ExternalAppForm
					// A save answers the stored application; a fresh form starts from it, not from what was typed.
					key={app.updatedAt}
					original={app}
					onSaved={() => {
						setSaved(true)
						invalidate()
					}}
					onCancel={() => navigate('access/external-apps')}
					onEdit={() => setSaved(false)}
				/>

				<div className="danger-zone">
					<div className="danger-zone-copy">
						<strong>Delete this application</strong>
						Removes its clients and roles, and revokes every sign-in through its clients.
					</div>
					<span className="spacer" />
					<button type="button" className="danger" onClick={() => setConfirming(true)}>
						<Icon name="trash" size={14} />
						Delete application
					</button>
				</div>
				{confirming && (
					<ConfirmDialog
						title="Delete external application"
						confirmLabel="Delete application"
						body={
							<p>
								Delete <strong>{title}</strong>? Its {app.clients.length === 1 ? 'client is' : `${app.clients.length} clients are`}{' '}
								removed and every sign-in through {app.clients.length === 1 ? 'it' : 'them'}{' '}
								is revoked: people signed in to it are signed out within five minutes. Its roles are removed with it.
							</p>
						}
						onConfirm={remove}
						onClose={() => setConfirming(false)}
					/>
				)}
			</>
		)
	})
