import { createPage, useNavigate } from '@buzola/router'
import { useEffect } from 'react'
import { accessTabEnvironment, AppFrame, loadAppFrame, useEnvironmentStates } from '../../components/app/AppFrame'
import { EmptyState } from '../../components/Table'

// The Access tab without an environment: it opens on the one the tab's link would choose; links to this address keep working.

export default createPage()
	.params({ id: 'string' })
	.loader(({ params }) => loadAppFrame(params.id))
	.route('/apps/:id/access')
	.render(({ data, params }) => {
		const navigate = useNavigate()
		const env = accessTabEnvironment(data.envs)
		const states = useEnvironmentStates(data.envs)
		useEffect(() => {
			if (env !== null) navigate('apps/access', { params: { id: params.id, env }, replace: true })
		}, [navigate, params.id, env])
		if (env !== null) return <div className="loading">Opening the environment's access…</div>
		return (
			<AppFrame app={data.app} envs={data.envs} tab="access" states={states}>
				<EmptyState icon="shield" title="No environments" body="An environment's endpoints and roles appear here once it is added and deployed." />
			</AppFrame>
		)
	})
