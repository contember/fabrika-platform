import { createPage, Link } from '@buzola/router'
import { AccessMapSection } from '../../components/app-detail/AccessMapSection'
import { AdminAccessSection } from '../../components/app-detail/AdminAccessSection'
import { DeviationsSection } from '../../components/app-detail/DeviationsSection'
import { SurfaceSection } from '../../components/app-detail/SurfaceSection'
import { AppFrame, loadAppFrame, useEnvironmentStates } from '../../components/app/AppFrame'
import { EmptyState } from '../../components/Table'
import { readSelfAdmin } from '../../lib/self-admin'
import { consoleSession } from '../../lib/session'

export default createPage()
	.params({ id: 'string', env: 'string' })
	.loader(async ({ params }) => {
		const [frame, session] = await Promise.all([loadAppFrame(params.id), consoleSession()])
		const selfAdmin = await readSelfAdmin(params.id, frame.envs.map((env) => env.env), session)
		return { ...frame, selfAdmin, people: session.administersPeople !== false }
	})
	.route('/apps/:id/access/:env')
	.render(({ data, params, invalidate }) => {
		const { app, envs, selfAdmin, people } = data
		const states = useEnvironmentStates(envs)
		const env = envs.find((candidate) => candidate.env === params.env)
		return (
			<AppFrame app={app} envs={envs} tab="access" states={states}>
				<AdminAccessSection state={selfAdmin} onDone={invalidate} />
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
					? <EmptyState icon="shield" title={`No environment ${params.env}`} body="Choose one of the application's environments above." />
					: (
						<>
							<SurfaceSection env={env} />
							<AccessMapSection env={env} people={people} />
							<DeviationsSection env={env} />
						</>
					)}
			</AppFrame>
		)
	})
