import { FABRIKA_PROXY_MANIFEST_JSON } from '@fabrika/proxy-core/manifest'
import { z } from 'zod'
import { appliedZeropsSetups, parseZeropsDescriptor, selectZeropsDescriptorSetup } from './descriptor'

/** The path of the proxy manifest in the build archive: the archive's one data file (ADR-0045), read by the proxy build. */
export const ZEROPS_PROXY_MANIFEST_PATH = 'proxy.manifest.json'

/**
 * How a proxy build receives its manifest.
 *
 * - `environment`: the build lifts `FABRIKA_PROXY_MANIFEST_JSON` from the service and writes it to the file, as every
 *   release before the archive carrier did. A namespace pinned to such a commit keeps its descriptor (ADR-0045), so it
 *   gets the variable, bound by the Zerops value limit.
 * - `archive`: the build reads the file the uploaded archive carries.
 */
export type ZeropsProxyManifestCarrier = 'environment' | 'archive'

const buildSectionSchema = z.object({ build: z.object({ envVariables: z.record(z.string()).optional() }).passthrough() }).passthrough()

/**
 * The carrier a descriptor's proxy setup reads. Decided by the build section Zerops applies (the selected setup's, else
 * the nearest one it `extends`): a lifted `FABRIKA_PROXY_MANIFEST_JSON` would overwrite an archived file, so it wins.
 */
export const zeropsProxyManifestCarrier = (descriptorContents: string, setup = 'proxy'): ZeropsProxyManifestCarrier => {
	const parsed = parseZeropsDescriptor(descriptorContents)
	for (const entry of appliedZeropsSetups(parsed, selectZeropsDescriptorSetup(parsed, setup))) {
		const read = buildSectionSchema.safeParse(entry)
		if (!read.success) continue
		return read.data.build.envVariables?.[FABRIKA_PROXY_MANIFEST_JSON] === undefined ? 'archive' : 'environment'
	}
	return 'archive'
}

/** The build variable that marks a proxy source whose manifest parser knows `brand` (ADR-0065). */
export const FABRIKA_PROXY_MANIFEST_BRAND = 'FABRIKA_PROXY_MANIFEST_BRAND'

/**
 * Whether a pinned descriptor's proxy reads a manifest that carries the installation's client logo. An older parser
 * refuses the unknown key and fails the build, so a namespace kept on such a pin gets no logo and keeps the fabrika
 * mark until it is re-pinned (`--proxy-source=current`). Decided by the build section Zerops applies, as the carrier is.
 */
export const zeropsProxyAcceptsBrand = (descriptorContents: string, setup = 'proxy'): boolean => {
	const parsed = parseZeropsDescriptor(descriptorContents)
	for (const entry of appliedZeropsSetups(parsed, selectZeropsDescriptorSetup(parsed, setup))) {
		const read = buildSectionSchema.safeParse(entry)
		if (!read.success) continue
		return read.data.build.envVariables?.[FABRIKA_PROXY_MANIFEST_BRAND] === '1'
	}
	return false
}
