import { ZEROPS_APPLICATION_PORT } from './execution'

/** The hostname of a namespace's dev sandbox host: a Zerops Box Workspace, which runs one sandbox per MCP workspace. */
export const SANDBOX_HOST_HOSTNAME = 'zbox'

/** The type an import declares. */
export const SANDBOX_HOST_TYPE = 'zbox@1'

/** The type the platform reads back for it (measured live): the OS-qualified form of `SANDBOX_HOST_TYPE`. */
export const SANDBOX_HOST_SERVICE_TYPE = 'ubuntu/zbox@1'

/** The Box API port. Control reaches it over the service's public subdomain, with the key Fabrika generated for it. */
export const SANDBOX_HOST_API_PORT = 8080

/** The Box router port: the namespace proxy reaches a sandbox's project-only application port here, by Host. */
export const SANDBOX_HOST_ROUTER_PORT = 8081

/** The service variable Box reads its API key from; Fabrika writes it sensitive and never reads it back. */
export const SANDBOX_HOST_KEY_VARIABLE = 'ZBOX_WORKSPACE_API_KEY'

/** The dial address of the Box router from the namespace proxy. */
export const SANDBOX_UPSTREAM = `${SANDBOX_HOST_HOSTNAME}:${SANDBOX_HOST_ROUTER_PORT}`

/** The Host the namespace proxy sends the Box router to reach a sandbox's application port: the bare form, no domain. */
export function sandboxUpstreamHost(sandboxId: string): string {
	if (!/^[a-z0-9]{1,32}$/.test(sandboxId)) throw new Error('zerops: a sandbox id is lower-case letters and digits')
	return `${ZEROPS_APPLICATION_PORT}-${sandboxId}`
}
