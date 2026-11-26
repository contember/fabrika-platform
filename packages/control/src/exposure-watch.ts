// The maintenance pass that reads back, between deploys, the exposure a deploy refuses (ADR-0043): a service reachable
// past the environment's proxy (on Zerops a `.zerops.app` subdomain, or a bucket the platform did not create private).
// Something outside a run (an operator, another token) can expose a service the last deploy verified, and no deploy
// would notice until the next one. Each environment is checked under its `<app>:<env>` deploy lease; a change in what
// is exposed raises one error event in the application's own Operations, and an exposure that lasts is not raised again.
// Logs coordinates, service names and the provider's reasons only.

import type { DeployLocks } from '@fabrika/platform'
import type { ControlProvider, ProviderExposure, ProviderExposureFinding } from '@fabrika/provider-contract'
import type { ControlRepositories } from './db'
import { acquireLease, runLeaseKey } from './lease'
import { sendControlEvent } from './operations-event'
import { providerEnvironment } from './run-lifecycle'

/** What one pass did, by environment. */
export interface ExposureWatchSummary {
	/** Environments read back. */
	checked: number
	/** Environments whose exposure changed and was raised: through their Operations, or the log alone without an ingest. */
	alerted: number
	/** Environments whose recorded exposure a check found gone. */
	cleared: number
	/** Environments left to the next pass: a run or another holder had the environment. */
	busy: number
	/** Environments whose check failed, or whose alert Operations did not take; the next pass tries again. */
	failed: number
}

export const NO_EXPOSURE_WATCH: ExposureWatchSummary = { checked: 0, alerted: 0, cleared: 0, busy: 0, failed: 0 }

export interface ExposureWatchDeps {
	readonly repositories: Pick<ControlRepositories, 'registry' | 'runs' | 'operationsCatalog'>
	readonly provider: ControlProvider & { readonly exposure: ProviderExposure }
	readonly locks: DeployLocks
	/** How Control reaches an application's ingest origin: the Worker's Operations binding, or the global `fetch`. */
	readonly ingest: (request: Request) => Promise<Response>
	/** Unix seconds. */
	readonly now: () => number
}

/** The provider, when it reads exposure back outside a run. */
export function exposureProvider(provider: ControlProvider | undefined): ExposureWatchDeps['provider'] | null {
	const exposure = provider?.exposure
	return provider === undefined || exposure === undefined ? null : { ...provider, exposure }
}

/** The findings in a stable order, as the recorded form: the same exposure always reads the same. */
export const exposureRecord = (findings: readonly ProviderExposureFinding[]): string =>
	`[${findings.map((finding) => JSON.stringify([finding.service, finding.reason])).sort().join(',')}]`

export async function watchExposure(deps: ExposureWatchDeps): Promise<ExposureWatchSummary> {
	const summary = { ...NO_EXPOSURE_WATCH }
	for (const row of await deps.repositories.registry.listAppEnvsByProvider(deps.provider.id)) {
		// A dev environment runs in workspace sandboxes, which no namespace proxy fronts as a service.
		if (row.kind === 'dev') continue
		const { app_id: appId, env } = row
		const lease = await acquireLease(deps.locks, runLeaseKey(appId, env))
		if (lease === null) {
			summary.busy++
			continue
		}
		try {
			// A run still running after its holder's lease went (a Control restart) may be importing services.
			if ((await deps.repositories.runs.listRuns({ appId, env, statuses: ['running'], limit: 1 })).length > 0) {
				summary.busy++
				continue
			}
			const findings = await deps.provider.exposure.check({ environment: await providerEnvironment(deps.repositories, row), signal: lease.signal })
			summary.checked++
			const outcome = await settle(deps, appId, env, findings, () => lease.assertHeld())
			if (outcome !== 'unchanged') summary[outcome]++
		} catch (error) {
			summary.failed++
			// The message only: an error object may carry a request, and so a credential.
			console.error(
				`exposure: ${appId}/${env} could not be read back, retried next pass: ${error instanceof Error ? error.message : 'unknown error'}`,
			)
		} finally {
			await lease.release()
		}
	}
	return summary
}

async function settle(
	deps: ExposureWatchDeps,
	appId: string,
	env: string,
	findings: readonly ProviderExposureFinding[],
	assertHeld: () => void,
): Promise<'alerted' | 'cleared' | 'failed' | 'unchanged'> {
	const recorded = await deps.repositories.registry.getExposureAlert(appId, env)
	if (findings.length === 0) {
		if (recorded === null) return 'unchanged'
		assertHeld()
		await deps.repositories.registry.clearExposureAlert(appId, env)
		console.info(`exposure: ${appId}/${env} no longer exposes a service past its proxy`)
		return 'cleared'
	}
	const record = exposureRecord(findings)
	if (record === recorded) return 'unchanged'
	const message = `${appId}/${env} became reachable past its proxy since its last deploy: `
		+ findings.map((finding) => `service \`${finding.service}\` ${finding.reason}`).join('; ')
	console.warn(`exposure: ${message}`)
	const delivery = await sendControlEvent(deps, appId, env, {
		type: 'FabrikaExposureDetected',
		message,
		level: 'error',
		fingerprint: ['fabrika-exposure-detected', appId, env, ...findings.map((finding) => finding.service).sort()],
	})
	if (delivery.outcome === 'failed') {
		console.error(
			delivery.status === undefined
				? `exposure: the alert of ${appId}/${env} could not reach its Operations; sent again next pass`
				: `exposure: the Operations of ${appId}/${env} answered the alert with ${delivery.status}; sent again next pass`,
		)
		return 'failed'
	}
	if (delivery.outcome === 'refused') {
		console.error(`exposure: the Operations of ${appId}/${env} refused the alert with ${delivery.status}; not sent again while it lasts`)
	}
	assertHeld()
	await deps.repositories.registry.recordExposureAlert(appId, env, record, deps.now())
	return 'alerted'
}
