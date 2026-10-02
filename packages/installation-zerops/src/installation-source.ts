import {
	decodeZeropsNamespaceProxySource,
	normalizeZeropsSourceRepository,
	prepareZeropsDescriptor,
	verifyZeropsNamespaceProxySource,
	type ZeropsNamespaceProxySource,
} from '@fabrika/provider-zerops'
import { realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { FABRIKA_REPOSITORY_URL } from './install-options'
import { type PreparedPlatformSource, preparePlatformSource } from './platform-source'

export type PlatformSourcePreparer = (sourceDir: string, signal: AbortSignal) => Promise<PreparedPlatformSource>

export const prepareInstallationSource: PlatformSourcePreparer = async (sourceDir, signal) => {
	const workspace = await realpath(fileURLToPath(new URL('../../../', import.meta.url)))
	if (await realpath(sourceDir) !== workspace) {
		throw new Error(
			'--source-dir must be the full checkout containing this installation module; run bun packages/cli/src/index.ts from that checkout instead of a packaged CLI',
		)
	}
	return preparePlatformSource(sourceDir, signal)
}

export const validateInstallationSetups = (source: PreparedPlatformSource, setups: readonly string[]): void => {
	for (const setup of setups) prepareZeropsDescriptor(source.descriptor.contents, setup)
}

export const FABRIKA_ZEROPS_PROXY_SOURCE_JSON = 'FABRIKA_ZEROPS_PROXY_SOURCE_JSON'

// Zerops interpolates environment values; JSON escapes preserve descriptor bytes after parsing.
export const serializeNamespaceProxySource = (source: ZeropsNamespaceProxySource): string => JSON.stringify(source).replaceAll('$', '\\u0024')

export const prepareNamespaceProxySource = async (source: PreparedPlatformSource): Promise<ZeropsNamespaceProxySource> => {
	const identity = decodeZeropsNamespaceProxySource({
		repository: normalizeZeropsSourceRepository(FABRIKA_REPOSITORY_URL),
		commitSha: source.commitSha,
		descriptor: source.descriptor,
	})
	await verifyZeropsNamespaceProxySource(identity)
	return identity
}
