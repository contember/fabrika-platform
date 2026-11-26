import { createPage } from '@buzola/router'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { ApprovalsSection } from '../../components/app-detail/ApprovalsSection'
import { AppFrame, loadAppFrame, useEnvironmentStates } from '../../components/app/AppFrame'
import { WaitingApprovals } from '../../components/app/WaitingApprovals'
import { api } from '../../lib/api'
import { mayDo } from '../../lib/console-access'
import { overviewRead } from '../../lib/overview'
import { consoleSession } from '../../lib/session'

// What waits for a decision on this application, and what each environment lets through without one.

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => {
		const { access } = await consoleSession()
		const [frame, approvals] = await Promise.all([
			loadAppFrame(params.id),
			overviewRead(access === null || mayDo(access, CONTROL_ACTIONS.ACCESS_APPROVE), () => api.approvals.list()),
		])
		return { ...frame, waiting: approvals.data?.items.filter((approval) => approval.run.appId === params.id) ?? null }
	})
	.route('/apps/:id/approvals')
	.render(({ data, invalidate }) => {
		const { app, envs, waiting } = data
		const states = useEnvironmentStates(envs)
		return (
			<AppFrame app={app} envs={envs} tab="approvals" states={states}>
				{waiting !== null && <WaitingApprovals waiting={waiting} />}
				<ApprovalsSection appId={app.id} envs={envs} onDone={invalidate} />
			</AppFrame>
		)
	})
