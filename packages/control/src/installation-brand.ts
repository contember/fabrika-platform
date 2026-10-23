import type { InstallationBrand } from '@fabrika/proxy-core/brand'
import { iamProvisioningClient, type IamProvisioningOptions } from './iam-provisioning'

/**
 * Where Control reads the installation's client logo for the proxy manifests it publishes (ADR-0066). IAM keeps it, so
 * IAM's own pages read it without Control; Control asks for it once per namespace mutation and hands it to the provider.
 * The logo is presentation: a read that fails publishes the manifest with fabrika's mark, never fails the mutation.
 */
export interface InstallationBrandSource {
	read(): Promise<InstallationBrand | null>
}

/** How long a read of the logo waits for IAM before the mutation goes on without it. */
export const BRAND_READ_TIMEOUT_MS = 5_000

export interface IamBrandSourceOptions extends IamProvisioningOptions {
	/** `BRAND_READ_TIMEOUT_MS` by default. */
	readonly timeoutMs?: number
}

/**
 * `brand.get` on IAM's admin RPC, with the provisioning key as the bearer and nothing else. The read is bounded: an IAM
 * that takes the connection and never answers would otherwise hold the namespace lease of every mutation that reads it.
 */
export function iamBrandSource(options: IamBrandSourceOptions): InstallationBrandSource {
	const call = options.fetch ?? fetch
	const timeoutMs = options.timeoutMs ?? BRAND_READ_TIMEOUT_MS
	const client = iamProvisioningClient({
		origin: options.origin,
		provisioningKey: options.provisioningKey,
		fetch: (input, init) => {
			const timeout = AbortSignal.timeout(timeoutMs)
			const signal = init?.signal == null ? timeout : AbortSignal.any([init.signal, timeout])
			return call(input, { ...init, signal })
		},
	})
	return {
		async read() {
			return (await client.brand.get()).brand
		},
	}
}
