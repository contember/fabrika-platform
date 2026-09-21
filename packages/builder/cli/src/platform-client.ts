import { type BuilderPlatformStatus, builderProjectPath, parseBuilderPlatformStatus } from '../../shared'
import { BASE_URL } from './config'
import { BuilderCliError } from './errors'

export async function platformRequest(
	sessionId: string,
	suffix: Parameters<typeof builderProjectPath>[1],
	body?: object,
	timeoutMs = 30_000,
): Promise<BuilderPlatformStatus> {
	let response: Response
	try {
		response = await fetch(`${BASE_URL}${builderProjectPath(sessionId, suffix)}`, {
			method: body === undefined ? 'GET' : 'POST',
			redirect: 'error',
			headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(timeoutMs),
		})
	} catch {
		throw new BuilderCliError('Local builder request failed. Check the local dashboard and retry.')
	}
	if (!response.ok) throw new BuilderCliError(`Local builder request refused (HTTP ${response.status}). Check the local dashboard.`)
	try {
		return parseBuilderPlatformStatus(await response.json())
	} catch {
		throw new BuilderCliError('Invalid local builder response.')
	}
}

export function publicPlatformStatus(status: BuilderPlatformStatus) {
	return {
		...status,
		pairing: status.pairing === null ? null : {
			status: status.pairing.status,
			...(status.pairing.status === 'pending' ? { expiresAt: status.pairing.expiresAt } : {}),
		},
		deployment: status.deployment === null ? null : { ...status.deployment, message: null },
	}
}
