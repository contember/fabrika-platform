import type { ControlProvider, ProviderEnvelope } from '@fabrika/provider-contract'

export const TEST_PROVIDER_ID = 'harbor'

const envelope = (kind: string): ProviderEnvelope => ({
	provider: TEST_PROVIDER_ID,
	version: 1,
	payload: { kind },
})

export function providerEnvironment(
	appId: string,
	env: string,
	options: { domain?: string | null; triggerRef?: string | null } = {},
) {
	return {
		appId,
		env,
		...options,
		namespaceId: null,
		provider: TEST_PROVIDER_ID,
		providerTargetJson: JSON.stringify(envelope('target')),
		providerArtifactJson: JSON.stringify(envelope('artifact')),
	}
}

/** A third provider keeps core tests independent of both shipped provider packages. */
export const fakeControlProvider: ControlProvider = {
	id: TEST_PROVIDER_ID,
	normalizeRegistration: (input) => input,
	deploy: () => Promise.resolve({ state: 'succeeded' }),
}
