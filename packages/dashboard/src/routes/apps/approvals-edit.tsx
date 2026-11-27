import { createPage, Link, useNavigate } from '@buzola/router'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { PolicyEditor } from '../../components/app-detail/ApprovalsSection'
import { AppFrame, loadAppFrame, useEnvironmentStates } from '../../components/app/AppFrame'
import { Icon } from '../../components/Icon'
import { EmptyState } from '../../components/Table'
import { mayDo } from '../../lib/console-access'
import { useConsoleAccess } from '../../lib/console-caller'

// Editing what lets a change through on one environment: its own page, so the matrix has the width it needs.

export default createPage()
	.params({ id: 'string', env: 'string' })
	.loader(({ params }) => loadAppFrame(params.id))
	.route('/apps/:id/approvals/:env/edit')
	.render(({ data, params, invalidate }) => {
		const { app, envs } = data
		const states = useEnvironmentStates(envs)
		const access = useConsoleAccess()
		const navigate = useNavigate()
		const env = envs.find((candidate) => candidate.env === params.env)
		const back = () => navigate('apps/approvals', { params: { id: app.id } })
		return (
			<AppFrame app={app} envs={envs} tab="approvals" states={states}>
				<div>
					<Link to="apps/approvals" params={{ id: app.id }} className="back-link">
						<Icon name="chevron-left" size={14} />
						Approvals
					</Link>
					<h2>What lets a change through on {params.env}</h2>
				</div>
				{env === undefined
					? <EmptyState title={`${app.id} has no environment ${params.env}.`} />
					: !mayDo(access, CONTROL_ACTIONS.ACCESS_APPROVE, { app: app.id, env: env.env })
					? <EmptyState icon="lock" title="Only a person who may approve on this environment changes its rules." />
					: !env.protected
					? <EmptyState title={`Approval is off on ${env.env}.`} body="Turn it on from the Approvals tab; its rules then apply and can be changed here." />
					: (
						<PolicyEditor
							key={JSON.stringify([env.appId, env.env, env.approvalPolicy, env.approvalSettings])}
							appId={app.id}
							env={env}
							onDone={() => {
								invalidate()
								back()
							}}
							onCancel={back}
						/>
					)}
			</AppFrame>
		)
	})
