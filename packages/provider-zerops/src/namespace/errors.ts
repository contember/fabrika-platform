import { ProviderNamespaceError } from '@fabrika/provider-contract'
import { ZeropsApiError, ZeropsServiceEnvValueTooLargeError } from '../api'
import { ZeropsSourceRateLimitedError } from '../source/port'
import { ZboxApiError, ZboxOperationFailed } from '../zbox'

/**
 * Lifecycle codes this provider defines where the platform has none of its own. They are an
 * operator-facing vocabulary, so they are stable identifiers rather than prose (backlog 72): a
 * platform code such as `insufficientPermissions` and one of these read the same way downstream.
 */
export const ZEROPS_NAMESPACE_CANCELLED = 'namespaceCancelled'

export const ZEROPS_NAMESPACE_LIFECYCLE = 'namespaceLifecycle'

export const ZEROPS_PROXY_DEPLOY_TIMEOUT = 'proxyDeployTimeout'

export const ZEROPS_PROXY_DEPLOY_FAILED = 'proxyDeployFailed'

export const ZEROPS_SUBDOMAIN_NOT_PUBLISHED = 'subdomainNotPublished'

export const ZEROPS_SOURCE_RATE_LIMITED = 'githubRateLimited'

/** A dev sandbox entry would be published to a namespace whose pinned proxy cannot parse one. */
export const ZEROPS_PROXY_SANDBOXES_UNSUPPORTED = 'proxySandboxesUnsupported'

/** A sandbox host was asked of a namespace that serves no custom domain, which a dev environment's wildcard needs. */
export const ZEROPS_SANDBOX_HOST_UNSUPPORTED = 'sandboxHostUnsupported'

/** The Box API did not accept the namespace's key after the service restarted with it. */
export const ZEROPS_SANDBOX_HOST_KEY_REFUSED = 'sandboxHostKeyRefused'

/** The Box API answered a request that carried no key, even after a restart with the namespace's key. */
export const ZEROPS_SANDBOX_HOST_API_OPEN = 'sandboxHostApiOpen'

/** A dev environment an older release registered with its own Zerops service, which runs in no sandbox. */
export const ZEROPS_DEV_TARGET_RETIRED = 'devTargetRetired'

export const namespaceError = (code: string, message: string, retryable: boolean, detail?: string): ProviderNamespaceError =>
	new ProviderNamespaceError(message, code, retryable, detail)

/**
 * `apiError` composes `zerops: <label> failed (<status>) — <code>: <server message>`. The half before the
 * first separator is OURS (a literal label and the status); the half after is the platform's, and it
 * REPEATS the code, which travels separately. Splitting them keeps the summary safe to show while the
 * upstream words survive in `detail`, where the control plane redacts them before they are stored or
 * logged — discarding them is what left three different live failures indistinguishable (backlog 72).
 *
 * A `redactDetail: true` call carries the code and nothing else, so it yields no detail at all.
 */
const splitApiMessage = (message: string, code: string): { summary: string; detail?: string } => {
	const at = message.indexOf(' — ')
	if (at === -1) return { summary: message }
	const summary = message.slice(0, at)
	const rest = message.slice(at + 3)
	if (code === '' || rest === code) return rest === code ? { summary } : { summary, detail: rest }
	const detail = rest.startsWith(`${code}: `) ? rest.slice(code.length + 2) : rest
	return detail === '' ? { summary } : { summary, detail }
}

/** Every namespace lifecycle failure leaves this provider as one typed, coded error. */
export const asNamespaceError = (cause: unknown, mode: 'provision' | 'reconcile' | 'update' | 'claim check'): ProviderNamespaceError => {
	if (cause instanceof ProviderNamespaceError) return cause
	// The same value is refused again on every retry; only a smaller manifest or a new carrier fixes it.
	if (cause instanceof ZeropsServiceEnvValueTooLargeError) return namespaceError(cause.code, cause.message, false)
	// The limit resets on its own: the namespace stays `provisioning` and the cron's reconcile retries it.
	if (cause instanceof ZeropsSourceRateLimitedError) return namespaceError(ZEROPS_SOURCE_RATE_LIMITED, cause.message, true)
	// The message is the operation, the status and Box's code only: Box echoes request data in its bodies.
	if (cause instanceof ZboxApiError) {
		return namespaceError(cause.code, cause.message, cause.status === 0 || cause.status === 429 || cause.status >= 500)
	}
	if (cause instanceof ZboxOperationFailed) return namespaceError(cause.code ?? 'zboxOperationFailed', cause.message, false)
	if (cause instanceof ZeropsApiError) {
		const { summary, detail } = splitApiMessage(cause.message, cause.code)
		return namespaceError(
			cause.code === '' ? `zeropsHttp${cause.status}` : cause.code,
			summary,
			cause.status === 429 || cause.status >= 500,
			detail,
		)
	}
	if (cause instanceof Error && cause.name === 'AbortError') {
		return namespaceError(ZEROPS_NAMESPACE_CANCELLED, `Zerops namespace ${mode} was cancelled`, true)
	}
	if (cause instanceof Error) {
		return namespaceError(ZEROPS_NAMESPACE_LIFECYCLE, cause.message, false)
	}
	return namespaceError(ZEROPS_NAMESPACE_LIFECYCLE, `Zerops namespace ${mode} failed`, false)
}
