import { createPage } from '@buzola/router'
import { UserAccessForm } from '../../../access/components/user-detail/AccessForm'
import { api } from '../../../access/lib/api'

export default createPage()
	.params({ id: 'string', grantId: 'string' })
	.loader(async ({ params }) => {
		const [principal, apps] = await Promise.all([api.principals.get({ principalId: params.id }), api.apps.list()])
		const grant = principal.grants.find((grant) => grant.id === params.grantId)
		if (grant === undefined) throw new Error('This access assignment no longer exists. Return to the user to see their current access.')
		return { principal, apps: apps.items, grant }
	})
	.route('/access/users/:id/grants/:grantId/edit')
	.render(({ data }) => <UserAccessForm key={data.grant.id} principal={data.principal} apps={data.apps} grant={data.grant} />)
