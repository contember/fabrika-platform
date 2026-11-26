import { createPage } from '@buzola/router'
import { SecretsSection } from '../../components/app-detail/SecretsSection'
import { VariablesSection } from '../../components/app-detail/VariablesSection'
import { AppFrame, loadAppFrame, useEnvironmentStates } from '../../components/app/AppFrame'
import { api } from '../../lib/api'

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => {
		const [frame, secrets, vars] = await Promise.all([
			loadAppFrame(params.id),
			api.apps.secrets.list({ appId: params.id }),
			api.apps.variables.list({ appId: params.id }),
		])
		return { ...frame, secrets: secrets.items, vars: vars.items }
	})
	.route('/apps/:id/secrets')
	.render(({ data, invalidate }) => {
		const { app, envs, secrets, vars } = data
		const states = useEnvironmentStates(envs)
		return (
			<AppFrame app={app} envs={envs} tab="secrets" states={states}>
				<SecretsSection appId={app.id} secrets={secrets} envs={envs} onDone={invalidate} />
				<VariablesSection appId={app.id} vars={vars} envs={envs} onDone={invalidate} />
			</AppFrame>
		)
	})
