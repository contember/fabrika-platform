import type { InstallationBrand } from '@fabrika/proxy-core/brand'
import { iamProvisioningClient, type IamProvisioningOptions } from './iam-provisioning'

/**
 * Where Control reads the installation's client logo for the proxy manifests it publishes (ADR-0065). IAM keeps it, so
 * IAM's own pages read it without Control; Control asks for it once per namespace mutation and hands it to the provider.
 * The logo is presentation: a read that fails publishes the manifest with fabrika's mark, never fails the mutation.
 */
export interface InstallationBrandSource {
	read(): Promise<InstallationBrand | null>
}

export type IamBrandSourceOptions = IamProvisioningOptions

/** `brand.get` on IAM's admin RPC, with the provisioning key as the bearer and nothing else. */
export function iamBrandSource(options: IamBrandSourceOptions): InstallationBrandSource {
	const client = iamProvisioningClient(options)
	return {
		async read() {
			return (await client.brand.get()).brand
		},
	}
}
