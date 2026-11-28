import { createPage, Link } from '@buzola/router'
import { appEnvironmentId } from '@fabrika/auth-core'
import { AccessMapSection } from '../../components/app-detail/AccessMapSection'
import { AdminAccessSection } from '../../components/app-detail/AdminAccessSection'
import { DeviationsSection } from '../../components/app-detail/DeviationsSection'
import { SurfaceSection } from '../../components/app-detail/SurfaceSection'
import { AppFrame, loadAppFrame, useEnvironmentStates } from '../../components/app/AppFrame'
import { EmptyState } from '../../components/Table'
import { readRoleHolders, roleHoldersTarget } from '../../lib/role-holders'
import { readSelfAdmin } from '../../lib/self-admin'
import { consoleSession } from '../../lib/session'

export default createPage()
	.params({ id: 'string', env: 'string' })
	.loader(async ({ params }) => {
		const [frame, session] = await Promise.all([loadAppFrame(params.id), consoleSession()])
		const peopleApps = session.peopleApps ?? []
		const envs = frame.envs.map((env) => env.env)
		// One IAM read per environment opened, which IAM records.
		const counted = roleHoldersTarget({ appId: params.id, env: params.env, envs, iam: session.iam, peopleApps })
		const [selfAdmin, holders] = await Promise.all([
			readSelfAdmin(params.id, envs, session),
			counted === null ? null : readRoleHolders(counted),
		])
		return { ...frame, selfAdmin, peopleApps, holders }
	})
	.route('/apps/:id/access/:env')
	.render(({ data, params, invalidate }) => {
		const { app, envs, selfAdmin, peopleApps, holders } = data
		const states = useEnvironmentStates(envs)
		const env = envs.find((candidate) => candidate.env === params.env)
		return (
			<AppFrame app={app} envs={envs} tab="access" states={states}>
				<div className="toolbar">
					<div className="filter-group" role="group" aria-label="Environment">
						{envs.map((candidate) => (
							<Link
								key={candidate.env}
								to="apps/access"
								params={{ id: app.id, env: candidate.env }}
								className="filter-option"
								aria-current={candidate.env === params.env ? 'page' : undefined}
							>
								{candidate.env}
							</Link>
						))}
					</div>
				</div>
				{env === undefined
					? envs.length === 0
						? <EmptyState icon="shield" title="No environments" body="An environment's endpoints and roles appear here once it is added and deployed." />
						: <EmptyState icon="shield" title={`No environment ${params.env}`} body="Choose one of the application's environments above." />
					: (
						<>
							<SurfaceSection env={env} />
							<AccessMapSection env={env} people={peopleApps.includes(appEnvironmentId(env.appId, env.env))} holders={holders} />
							<DeviationsSection env={env} />
						</>
					)}
				<AdminAccessSection state={selfAdmin} onDone={invalidate} />
			</AppFrame>
		)
	})
