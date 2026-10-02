import type { JsonValue } from '@fabrika/provider-contract'
import { parseProviderJson, type RunRepository } from './db'

export const retainedCheckpointReader = (
	runs: Pick<RunRepository, 'getRunByExternalId'>,
	coordinates: { appId: string; env: string },
	signal: AbortSignal,
): (externalId: string) => Promise<JsonValue | null> =>
async (externalId) => {
	signal.throwIfAborted()
	const run = await runs.getRunByExternalId({ ...coordinates, externalId })
	signal.throwIfAborted()
	return run?.provider_state_json == null ? null : parseProviderJson(run.provider_state_json, 'retained provider checkpoint')
}
