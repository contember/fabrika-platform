import { createPage, Link, useNavigate } from '@buzola/router'
import { ExternalAppForm } from '../../../access/components/ExternalAppForm'
import { Icon } from '../../../components/Icon'

/** Register an external application: its record, roles and clients in one save, with no deploy (ADR-0089). */
export default createPage()
	.route('/access/external-apps/new')
	.render(() => {
		const navigate = useNavigate()
		return (
			<>
				<div className="page-head">
					<Link to="access/external-apps" className="back-link">
						<Icon name="chevron-left" size={14} />
						All external applications
					</Link>
					<h1>Register external application</h1>
					<p className="hint">An application outside this installation that signs people in through IAM. It takes effect at once; nothing is deployed.</p>
				</div>
				<ExternalAppForm
					original={null}
					onSaved={(saved) => navigate('access/external-apps/detail', { params: { app: saved.app } })}
					onCancel={() => navigate('access/external-apps')}
				/>
			</>
		)
	})
