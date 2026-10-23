import { createPage } from '@buzola/router'
import { UserAccessForm } from '../../../access/components/user-detail/AccessForm'
import { api } from '../../../access/lib/api'

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => {
		const [principal, apps] = await Promise.all([api.principals.get({ principalId: params.id }), api.apps.list()])
		return { principal, apps: apps.items }
	})
	.route('/access/users/:id/grants/new')
	.render(({ data }) => <UserAccessForm key={data.principal.id} principal={data.principal} apps={data.apps} />)
