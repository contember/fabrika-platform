import type { RunAttempt } from '@fabrika/provider-contract'
import { z } from 'zod'
import { ZEROPS_ACTIVE, ZEROPS_TERMINAL, type ZeropsApi, type ZeropsAppVersion } from './api'
import type { ZeropsRunState } from './types'
import { deleteVersion, isVersionNotFound } from './version-attempt'

/** A run stops waiting for its version this long after it started. Zerops' own pipeline limit is 1 hour. */
export const ZEROPS_VERSION_DEADLINE_MS = 75 * 60 * 1000

const checkpointSchema = z.object({ appVersionId: z.string().min(1), triggered: z.boolean() }).strict()

/** The run checkpoint (ADR-0044), or null for anything else — an older shape included. */
export const parseZeropsCheckpoint = (value: unknown): ZeropsRunState | null => {
	const result = checkpointSchema.safeParse(value)
	return result.success ? result.data : null
}

/** A version answer about another version or service than the run's is a definite failure, never a retry. */
export const assertVersionCoordinates = (appVersionId: string, serviceId: string, version: ZeropsAppVersion): void => {
	if (version.id !== appVersionId || (version.serviceStackId !== undefined && version.serviceStackId !== serviceId)) {
		throw new Error('Zerops app-version response has different coordinates')
	}
}

/**
 * The Zerops candidate of a deploy run: the reserved app version. `triggered` is set before the build request, which
 * also activates the version, so a triggered version is settled only by polling it. `serviceId` is read only once a
 * version answered, so a target that names no service fails the read, not the parse.
 */
export const zeropsRunAttempt = (
	api: Pick<ZeropsApi, 'getAppVersion' | 'deleteAppVersion' | 'cancelBuild'>,
	serviceId: () => string,
): RunAttempt<ZeropsRunState> => ({
	parse: parseZeropsCheckpoint,
	encode: (checkpoint) => ({ ...checkpoint }),
	externalId: (checkpoint) => checkpoint.appVersionId,
	submitted: (checkpoint) => checkpoint.triggered,
	discard: (checkpoint, signal) => deleteVersion(api, checkpoint.appVersionId, signal),
	observe: async (checkpoint, signal) => {
		const { appVersionId } = checkpoint
		let version: ZeropsAppVersion
		try {
			signal.throwIfAborted()
			version = await api.getAppVersion({ appVersionId, signal })
		} catch (error) {
			if (signal.aborted) return { state: 'unobservable', cause: signal.reason }
			if (!isVersionNotFound(error)) return { state: 'unobservable', cause: error }
			return { state: 'absent' }
		}
		assertVersionCoordinates(appVersionId, serviceId(), version)
		if (version.status === ZEROPS_ACTIVE) return { state: 'active' }
		if (version.status !== undefined && ZEROPS_TERMINAL.has(version.status)) {
			return { state: 'failed', reason: `app-version ${appVersionId} is ${version.status}` }
		}
		return { state: 'pending', ...(version.status === undefined ? {} : { status: version.status }) }
	},
	stop: (checkpoint, signal) => api.cancelBuild({ appVersionId: checkpoint.appVersionId, signal }),
	deadlineMs: ZEROPS_VERSION_DEADLINE_MS,
	words: {
		provider: 'zerops',
		candidate: (checkpoint) => `app-version ${checkpoint.appVersionId}`,
		discarded: 'deleted',
		notDiscarded: 'could not be deleted; it was never built',
		submission: 'requested the build',
	},
})
