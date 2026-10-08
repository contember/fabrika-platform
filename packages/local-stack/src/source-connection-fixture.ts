export interface LocalSourceConnectionFixture {
	readonly connectionId: string
	readonly githubAppId: string
	readonly owner: string
	readonly installationId: number
}

/** Two independent keyed connections, so local routing has to select the exact one. */
export const LOCAL_SOURCE_CONNECTIONS: readonly LocalSourceConnectionFixture[] = [
	{ connectionId: 'local-keyed-alpha', githubAppId: '1002', owner: 'local-alpha', installationId: 10_002 },
	{ connectionId: 'local-keyed-beta', githubAppId: '1003', owner: 'local-beta', installationId: 10_003 },
]
