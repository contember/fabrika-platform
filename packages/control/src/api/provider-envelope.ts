import type { ProviderEnvelope } from '@fabrika/provider-contract'
import { z } from 'zod'
import { jsonValueSchema } from '../json-value'

export const providerEnvelopeSchema = z.object({
	provider: z.string(),
	version: z.number().int().min(1),
	payload: jsonValueSchema,
})

export const lifecycleEnvelopeSchema = providerEnvelopeSchema.extend({
	provider: z.string().min(1),
	version: z.number().int(),
})

export function readProviderEnvelope(value: unknown): ProviderEnvelope | null {
	const parsed = providerEnvelopeSchema.safeParse(value)
	return parsed.success ? parsed.data : null
}

export function parseStoredEnvelope(value: string, label: string): ProviderEnvelope {
	const parsed: unknown = JSON.parse(value)
	const envelope = readProviderEnvelope(parsed)
	if (envelope === null) {
		throw new Error(`${label} is not a versioned provider envelope`)
	}
	return envelope
}
