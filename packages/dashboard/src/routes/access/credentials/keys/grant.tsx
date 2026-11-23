import { createPage } from '@buzola/router'
import { KeyGrantForm } from '../../../../access/components/KeyGrantForm'
import { api } from '../../../../access/lib/api'

/** Add one grant to an API key, with the composer provisioning uses. The key keeps its secret. */
export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => {
		const [apiKey, apps] = await Promise.all([
			api.apiKeys.get({ principalId: params.id }),
			api.apps.list(),
		])
		return { apiKey, apps: apps.items }
	})
	.route('/access/credentials/keys/:id/grants/new')
	.render(({ data }) => <KeyGrantForm key={data.apiKey.principalId} apiKey={data.apiKey} apps={data.apps} />)
