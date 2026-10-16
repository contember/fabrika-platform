import { RpcError } from '@fabrika/app'
import type { AppEnvDto, ApprovalDto } from '@fabrika/control-contract'
import type { createControlClient } from './api'

type ControlClient = ReturnType<typeof createControlClient>

/** Turning approvals off waits for an explicit confirmation; turning them on applies at once. */
export type ProtectionToggle = 'confirm' | 'apply'

export function protectionToggle(next: boolean): ProtectionToggle {
	return next ? 'apply' : 'confirm'
}

/** Control's `apps.environments.protect`: `access.approve` from a person in the console, audited (ADR-0050 §4). */
export function setEnvironmentProtection(client: ControlClient, appId: string, env: string, value: boolean): Promise<AppEnvDto> {
	return client.apps.environments.protect({ appId, env, protected: value })
}

/** The deploys of one environment that wait for a person; turning approvals off decides none of them. */
export function parkedRunsAt(approvals: readonly ApprovalDto[], appId: string, env: string): ApprovalDto[] {
	return approvals.filter((approval) => approval.run.appId === appId && approval.run.env === env)
}

export function protectionFailure(cause: unknown, env: string): string {
	if (!(cause instanceof RpcError)) return 'Changing approvals failed.'
	switch (cause.httpStatus) {
		case 409:
			return `A deploy of ${env} is running. Approvals change between deploys: try again when it finishes.`
		case 403:
			return 'Only a person signed in to the console changes approvals, never a key or an agent.'
		case 404:
			return `You do not hold access.approve on ${env}, or the environment no longer exists.`
		default:
			return cause.message
	}
}
