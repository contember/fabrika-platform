import { reconcileSchema } from '@fabrika/auth'
import type { SchemaReconciler } from '@fabrika/provider-contract'
import { createZeropsApi, type ZeropsApi } from './api'
import type { ZeropsRuntimeTarget } from './types'

export type Sleeper = (ms: number, signal: AbortSignal) => Promise<void>

export const defaultSleep: Sleeper = (ms, signal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted) {
			resolve()
			return
		}
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort)
			resolve()
		}, ms)
		const onAbort = (): void => {
			clearTimeout(timer)
			resolve()
		}
		signal.addEventListener('abort', onAbort, { once: true })
	})

export interface ZeropsCollaborators {
	api: ZeropsApi
	reconcileSchema: SchemaReconciler
	sleep: Sleeper
}

export type ZeropsCollaboratorFactory = (target: ZeropsRuntimeTarget) => ZeropsCollaborators

const defaultReconcileSchema: SchemaReconciler = (input) =>
	reconcileSchema({
		url: input.url,
		app: input.app,
		schema: input.schema,
		...(input.returnOrigins === undefined ? {} : { returnOrigins: input.returnOrigins }),
		adminKey: input.adminKey,
		signal: input.signal,
	})

export const defaultZeropsCollaborators: ZeropsCollaboratorFactory = (target) => ({
	api: createZeropsApi({ token: target.accessToken, baseUrl: target.apiBaseUrl }),
	reconcileSchema: defaultReconcileSchema,
	sleep: defaultSleep,
})
