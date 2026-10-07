import { ZeropsApiError } from './api/errors'
import type { ZeropsApi } from './api/types'

export const isVersionNotFound = (error: unknown): boolean =>
	error instanceof ZeropsApiError && error.status === 400 && error.code === 'appVersionNotFound'

/**
 * Delete a reserved version whose build was never requested. Deletion is the barrier: a later upload to
 * it leaves nothing buildable and a build request fails `appVersionNotFound` (ADR-0044). An already
 * absent version counts as deleted. Never call this once a build may have been submitted.
 */
export async function deleteVersion(api: Pick<ZeropsApi, 'deleteAppVersion'>, appVersionId: string, signal: AbortSignal): Promise<void> {
	try {
		await api.deleteAppVersion({ appVersionId, signal })
	} catch (error) {
		if (!isVersionNotFound(error)) throw error
	}
}
