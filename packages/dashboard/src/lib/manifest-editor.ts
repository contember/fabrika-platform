import { z } from 'zod'
import type { AppEnvDto, JsonValue } from './api'
import { isJsonValue } from './json'

const manifestHeader = z.object({ manifestVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })

export function parseManifestEditor(text: string): { payload: JsonValue; version: number } {
	let payload: JsonValue
	try {
		const parsed: unknown = JSON.parse(text)
		if (!isJsonValue(parsed)) throw new Error('manifest is not JSON')
		payload = parsed
	} catch {
		throw new Error('Paste a valid fabrika.manifest.json.')
	}
	const header = manifestHeader.safeParse(payload)
	if (!header.success) {
		throw new Error('That file declares no manifestVersion — paste the fabrika.manifest.json that `fabrika app build` wrote.')
	}
	return { payload, version: header.data.manifestVersion }
}

export function cloudflareConfigPath(envelope: AppEnvDto['artifact']): string | null {
	if (
		envelope.provider !== 'cloudflare' || envelope.version !== 1
		|| typeof envelope.payload !== 'object' || envelope.payload === null || Array.isArray(envelope.payload)
	) return null
	const { configPath } = envelope.payload
	return typeof configPath === 'string' ? configPath : null
}

export function cloudflareArtifactWithConfigPath(envelope: AppEnvDto['artifact'], configPath: string): AppEnvDto['artifact'] {
	if (
		envelope.provider !== 'cloudflare' || envelope.version !== 1
		|| typeof envelope.payload !== 'object' || envelope.payload === null || Array.isArray(envelope.payload)
	) return envelope
	return { ...envelope, payload: { ...envelope.payload, configPath } }
}
