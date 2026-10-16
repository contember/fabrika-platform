import type { ApiKeyCredentialDto, AppDto } from '@fabrika/iam-contract'

/**
 * The applications a grant on an API key may name. A key bound to one app mints tokens for that app only, so a grant
 * at any other app, cross-app included, would never reach its token. A key bound to none takes what provisioning takes.
 */
export function keyGrantTargets(apps: readonly AppDto[], credential: ApiKeyCredentialDto | null): { apps: AppDto[]; crossApp: boolean } {
	const bound = credential?.app ?? null
	if (bound === null) return { apps: [...apps], crossApp: true }
	return { apps: apps.filter((app) => app.id === bound), crossApp: false }
}
