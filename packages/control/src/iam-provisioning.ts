import { createRpcClient, type InferRpcClient, type RpcFetch } from '@fabrika/app'
import type { IamAdminRpcContract } from '@fabrika/iam-contract'

export interface IamProvisioningOptions {
	/** IAM's public origin, the installation's `FABRIKA_IAM_ISSUER`. */
	readonly origin: string
	/** The installation's provisioning key: the credential every deploy reconciles IAM with. */
	readonly provisioningKey: string
	readonly fetch?: RpcFetch
}

/** IAM's admin RPC with the provisioning key as the bearer and nothing else: the one way Control calls IAM as itself. */
export function iamProvisioningClient(options: IamProvisioningOptions): InferRpcClient<IamAdminRpcContract> {
	const call = options.fetch ?? fetch
	return createRpcClient<IamAdminRpcContract>({
		baseUrl: `${options.origin.replace(/\/+$/, '')}/admin/rpc`,
		bounceOnAuth: false,
		fetch: (input, init) => {
			const headers = new Headers(init?.headers)
			headers.set('authorization', `Bearer ${options.provisioningKey}`)
			return call(input, { ...init, headers })
		},
	})
}
