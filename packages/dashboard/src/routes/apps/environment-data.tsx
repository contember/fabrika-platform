import { createPage, useNavigate } from '@buzola/router'
import { useEffect } from 'react'

// The address an environment's data had before it became a tab of the application's page; links to it keep working.

export default createPage()
	.params({ id: 'string', env: 'string' })
	.route('/apps/:id/environments/:env/data')
	.render(({ params }) => {
		const navigate = useNavigate()
		useEffect(() => {
			navigate('apps/data', { params: { id: params.id, env: params.env }, replace: true })
		}, [navigate, params.id, params.env])
		return <div className="loading">Opening the environment's data…</div>
	})
