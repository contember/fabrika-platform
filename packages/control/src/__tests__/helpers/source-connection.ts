import type { SourceConnectionPort } from '../../github/connections/port'

/** A connection port for request paths that never reach GitHub App administration. */
export function unusedSourceConnection(provider: string): SourceConnectionPort {
	const unused = (): Promise<never> => Promise.reject(new Error('source connection is not exercised by this test'))
	return { provider, verifyApp: unused, configureWebhook: unused, verifyInstallations: unused }
}
