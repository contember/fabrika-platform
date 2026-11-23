import { createPage } from '@buzola/router'
import { KeyGrantForm } from '../../../../access/components/KeyGrantForm'
import { api } from '../../../../access/lib/api'

/** Change one grant of an API key in place: its actions or role, scope and expiry. Its app stays. */
export default createPage()
	.params({ id: 'string', grantId: 'string' })
	.loader(async ({ params }) => {
		const [apiKey, apps] = await Promise.all([
			api.apiKeys.get({ principalId: params.id }),
			api.apps.list(),
		])
		const grant = apiKey.grants.find((grant) => grant.id === params.grantId)
		if (grant === undefined) throw new Error('This grant no longer exists. Return to the key to see its current grants.')
		return { apiKey, apps: apps.items, grant }
	})
	.route('/access/credentials/keys/:id/grants/:grantId/edit')
	.render(({ data }) => <KeyGrantForm key={data.grant.id} apiKey={data.apiKey} apps={data.apps} grant={data.grant} />)
