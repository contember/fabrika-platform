import { useNavigate } from '@buzola/router'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { mayDo } from '../../lib/console-access'
import { useConsoleAccess } from '../../lib/console-caller'
import { Icon } from '../Icon'

/**
 * Deploy one environment now and follow the run; offered to a holder of `deploy.trigger` there. Never the page's filled
 * button. `named` puts the environment in the visible text, where the button does not stand in that environment's row.
 */
export function DeployButton({ appId, env, named = false }: { appId: string; env: string; named?: boolean }) {
	const access = useConsoleAccess()
	const navigate = useNavigate()
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function deploy() {
		setBusy(true)
		setError(null)
		try {
			const run = await api.deploy({ appId, env })
			navigate('runs/detail', { params: { id: run.id } })
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Deploy failed.')
			setBusy(false)
		}
	}

	if (!mayDo(access, CONTROL_ACTIONS.DEPLOY_TRIGGER, { app: appId, env })) return null

	return (
		<div className="environment-deploy">
			<button
				type="button"
				className="small"
				onClick={deploy}
				disabled={busy}
				aria-label={named ? undefined : busy ? `Deploying ${env}` : `Deploy ${env}`}
			>
				<Icon name="bolt" size={12} />
				{busy ? 'Deploying…' : named ? `Deploy ${env}` : 'Deploy'}
			</button>
			{error && <div className="error-text small" role="alert">{error}</div>}
		</div>
	)
}
