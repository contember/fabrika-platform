import type { ProviderEnvelopeDto } from './api'
import { parseManifestEditor } from './manifest-editor'

/** The providers whose registration payload this console can build. */
export type FormProvider = 'cloudflare' | 'zerops'

/** Narrow the installation's provider id; `null` means the console has no form for it. */
export function formProvider(id: string): FormProvider | null {
	return id === 'cloudflare' || id === 'zerops' ? id : null
}

/** What a registration form collected. Each provider reads only the fields its form shows. */
export interface ProviderFormFields {
	readonly configPath: string
	readonly manifest: string
	readonly namespaceId: string
}

export interface ProviderRegistrationPayload {
	readonly namespaceId: string | null
	readonly target: ProviderEnvelopeDto
	readonly artifact: ProviderEnvelopeDto
}

/** Build a new environment's placement and envelopes. Throws a user-facing message on an invalid manifest. */
export function providerRegistrationPayload(provider: FormProvider, fields: ProviderFormFields): ProviderRegistrationPayload {
	if (provider === 'cloudflare') {
		return {
			namespaceId: null,
			target: { provider: 'cloudflare', version: 1, payload: {} },
			artifact: { provider: 'cloudflare', version: 1, payload: { configPath: fields.configPath.trim() } },
		}
	}
	// The pasted manifest declares the version its provider's codec accepts. A literal here goes
	// stale the moment that codec moves, and registration then refuses every artifact.
	const manifest = parseManifestEditor(fields.manifest)
	return {
		namespaceId: fields.namespaceId,
		target: { provider: 'zerops', version: manifest.version, payload: {} },
		artifact: { provider: 'zerops', version: manifest.version, payload: manifest.payload },
	}
}
