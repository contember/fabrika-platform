import { createPage, useNavigate } from '@buzola/router'
import { useState } from 'react'
import { NamespaceSignature } from '../../components/NamespaceSignature'
import {
	api,
	ApiError,
	type AppDto,
	type CreateDeploymentNamespaceRequest,
	type DeploymentNamespaceDetailDto,
	type DeploymentNamespaceListResponse,
	type ListResponse,
	type PlanDeploymentNamespaceRequest,
	type PlanDeploymentNamespaceResponse,
} from '../../lib/api'

export default createPage()
	.loader(async () => {
		const [namespaces, apps] = await Promise.all([
			api.get<DeploymentNamespaceListResponse>('/namespaces'),
			api.get<ListResponse<AppDto>>('/apps'),
		])
		return { operator: namespaces.operator, apps: apps.items }
	})
	.route('/namespaces/new')
	.render(({ data }) => {
		const navigate = useNavigate()
		const firstPreset = data.operator?.presets[0]?.id ?? ''
		const [id, setId] = useState('')
		const [env, setEnv] = useState('prod')
		const [preset, setPreset] = useState(firstPreset)
		const [exclusiveAppId, setExclusiveAppId] = useState('')
		const [plan, setPlan] = useState<PlanDeploymentNamespaceResponse | null>(null)
		const [busy, setBusy] = useState<'plan' | 'provision' | null>(null)
		const [error, setError] = useState<string | null>(null)

		if (data.operator === null || data.operator.presets.length === 0) {
			return (
				<div className="gate-screen">
					<h1>Namespace provisioning unavailable</h1>
					<p>The selected provider does not expose an operator placement preset.</p>
					<button type="button" onClick={() => navigate('namespaces')}>Back to namespaces</button>
				</div>
			)
		}

		const selectedPreset = data.operator.presets.find((item) => item.id === preset)
		const planDisabled = id.trim() === ''
			|| env.trim() === ''
			|| selectedPreset === undefined
			|| (selectedPreset.requiresExclusiveApp && exclusiveAppId === '')

		function change(setter: (value: string) => void, value: string) {
			setter(value)
			setPlan(null)
			setError(null)
		}

		async function preparePlan(event: React.FormEvent) {
			event.preventDefault()
			if (selectedPreset === undefined) return
			setBusy('plan')
			setError(null)
			const body: PlanDeploymentNamespaceRequest = {
				id: id.trim(),
				env: env.trim(),
				preset: selectedPreset.id,
				...(selectedPreset.requiresExclusiveApp ? { exclusiveAppId } : {}),
			}
			try {
				setPlan(await api.post<PlanDeploymentNamespaceResponse>('/namespaces/plan', body))
			} catch (cause) {
				setError(cause instanceof ApiError ? cause.message : 'Placement plan failed.')
			} finally {
				setBusy(null)
			}
		}

		async function provision() {
			if (plan === null) return
			setBusy('provision')
			setError(null)
			const body: CreateDeploymentNamespaceRequest = {
				id: plan.namespace.id,
				env: plan.namespace.env,
				exclusiveAppId: plan.namespace.exclusiveAppId ?? null,
				target: plan.namespace.target,
			}
			try {
				const created = await api.post<DeploymentNamespaceDetailDto>('/namespaces', body)
				navigate('namespaces/detail', { params: { id: created.id } })
			} catch (cause) {
				setError(cause instanceof ApiError ? cause.message : 'Namespace provisioning failed.')
				setBusy(null)
			}
		}

		return (
			<>
				<div className="page-head">
					<h1>Provision deployment namespace</h1>
					<p className="hint">Prepare the provider-owned plan, review its boundary, then provision it.</p>
				</div>

				<form className="panel form" onSubmit={preparePlan}>
					<div className="form-row">
						<label>
							Namespace id
							<input required value={id} onChange={(event) => change(setId, event.target.value)} placeholder="apps-prod" autoComplete="off" />
						</label>
						<label>
							Environment
							<input required value={env} onChange={(event) => change(setEnv, event.target.value)} placeholder="prod" autoComplete="off" />
						</label>
					</div>
					<label>
						Placement preset
						<select value={preset} onChange={(event) => change(setPreset, event.target.value)}>
							{data.operator.presets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
						</select>
						{selectedPreset !== undefined && <span className="hint">{selectedPreset.description}</span>}
					</label>
					{selectedPreset?.requiresExclusiveApp === true && (
						<label>
							Exclusive app
							<select required value={exclusiveAppId} onChange={(event) => change(setExclusiveAppId, event.target.value)}>
								<option value="">Select an app</option>
								{data.apps.map((app) => <option key={app.id} value={app.id}>{app.id}</option>)}
							</select>
							<span className="hint">Only this app can be assigned to the placement.</span>
						</label>
					)}
					{error && <p className="error-text" role="alert">{error}</p>}
					<div className="form-actions">
						<button type="submit" className="primary" disabled={busy !== null || planDisabled}>
							{busy === 'plan' ? 'Preparing…' : plan === null ? 'Prepare plan' : 'Refresh plan'}
						</button>
					</div>
				</form>

				{plan !== null && (
					<section>
						<h2>Provider plan</h2>
						<NamespaceSignature
							id={plan.namespace.id}
							env={plan.namespace.env}
							provider={plan.namespace.target.provider}
							exclusiveAppId={plan.namespace.exclusiveAppId ?? null}
							presentation={plan.presentation}
						/>
						<div className="form-actions namespace-provision-actions">
							<button type="button" className="primary" disabled={busy !== null} onClick={provision}>
								{busy === 'provision' ? 'Provisioning…' : 'Provision namespace'}
							</button>
							<button type="button" disabled={busy !== null} onClick={() => setPlan(null)}>Discard plan</button>
						</div>
					</section>
				)}
			</>
		)
	})
