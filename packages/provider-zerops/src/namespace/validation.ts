import type { ZeropsService } from '../api'

/**
 * The profile a service is checked against. `declared` is what the stored target says. `changingTo` is
 * set only while an update moves the service, and `unconfirmed` while it retries an earlier update whose
 * outcome is unknown: a live service already on either reads as the change in progress, not as drift.
 */
export interface ZeropsExpectedProfile {
	readonly declared?: string
	readonly changingTo?: string
	readonly unconfirmed?: string
}

export const validateService = (
	service: ZeropsService,
	projectId: string,
	expectedBase: string,
	adopting: boolean,
	expectedPublic?: boolean,
	expectedProfile: ZeropsExpectedProfile = {},
): void => {
	if (service.id === '') {
		throw new Error(`Zerops namespace service \`${service.name}\` returned an empty id`)
	}
	if (service.projectId !== undefined && service.projectId !== projectId) {
		throw new Error(`Zerops namespace service \`${service.name}\` belongs to another project`)
	}
	if ((adopting || service.base !== undefined) && service.base !== expectedBase) {
		throw new Error(`Zerops namespace service \`${service.name}\` uses ${service.base ?? 'an unknown type'}, expected ${expectedBase}`)
	}
	if (expectedPublic !== undefined && adopting && service.subdomainAccess !== expectedPublic) {
		throw new Error(`Zerops namespace service \`${service.name}\` has incompatible public access`)
	}
	const live = service.autoscalingProfileId
	if (live !== undefined && (live === expectedProfile.changingTo || live === expectedProfile.unconfirmed)) {
		return
	}
	if (expectedProfile.declared !== undefined && live !== expectedProfile.declared) {
		throw new Error(
			`Zerops namespace service \`${service.name}\` uses profile ${live ?? 'unknown'}, but its namespace declares ${expectedProfile.declared}`,
		)
	}
}
