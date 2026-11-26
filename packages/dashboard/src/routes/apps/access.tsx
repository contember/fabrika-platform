import { createPage } from '@buzola/router'
import { AccessMapSection } from '../../components/app-detail/AccessMapSection'
import { AdminAccessSection } from '../../components/app-detail/AdminAccessSection'
import { DeviationsSection } from '../../components/app-detail/DeviationsSection'
import { SurfaceSection } from '../../components/app-detail/SurfaceSection'
import { AppFrame, loadAppFrame, useEnvironmentStates } from '../../components/app/AppFrame'
import { readSelfAdmin } from '../../lib/self-admin'
import { consoleSession } from '../../lib/session'

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => {
		const [frame, session] = await Promise.all([loadAppFrame(params.id), consoleSession()])
		const selfAdmin = await readSelfAdmin(params.id, frame.envs.map((env) => env.env), session)
		return { ...frame, selfAdmin }
	})
	.route('/apps/:id/access')
	.render(({ data, invalidate }) => {
		const { app, envs, selfAdmin } = data
		const states = useEnvironmentStates(envs)
		return (
			<AppFrame app={app} envs={envs} tab="access" states={states}>
				<AdminAccessSection state={selfAdmin} onDone={invalidate} />
				<SurfaceSection envs={envs} />
				<AccessMapSection envs={envs} />
				<DeviationsSection envs={envs} />
			</AppFrame>
		)
	})
