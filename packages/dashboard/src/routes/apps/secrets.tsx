import { createPage } from '@buzola/router'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { SecretsSection } from '../../components/app-detail/SecretsSection'
import { VariablesSection } from '../../components/app-detail/VariablesSection'
import { AppFrame, loadAppFrame, useEnvironmentStates } from '../../components/app/AppFrame'
import { api } from '../../lib/api'
import { holdsAtApp } from '../../lib/console-access'
import { consoleSession } from '../../lib/session'

// Variables need only the application's manager; secrets also `secret.manage` there, so a manager without it sees variables.

export default createPage()
	.params({ id: 'string' })
	.loader(async ({ params }) => {
		const { access } = await consoleSession()
		const managesSecrets = access === null || holdsAtApp(access, CONTROL_ACTIONS.SECRET_MANAGE, params.id)
		const [frame, secrets, vars] = await Promise.all([
			loadAppFrame(params.id),
			managesSecrets ? api.apps.secrets.list({ appId: params.id }).then((list) => list.items) : null,
			api.apps.variables.list({ appId: params.id }),
		])
		return { ...frame, secrets, vars: vars.items }
	})
	.route('/apps/:id/secrets')
	.render(({ data, invalidate }) => {
		const { app, envs, secrets, vars } = data
		const states = useEnvironmentStates(envs)
		return (
			<AppFrame app={app} envs={envs} tab="secrets" states={states}>
				{secrets !== null && <SecretsSection appId={app.id} secrets={secrets} envs={envs} onDone={invalidate} />}
				<VariablesSection appId={app.id} vars={vars} envs={envs} onDone={invalidate} />
			</AppFrame>
		)
	})
