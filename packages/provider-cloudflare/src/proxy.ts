import type { AppGates } from '@fabrika/auth'
import { encodeProxyManifestJson, type ProxyManifest } from '@fabrika/proxy-contract'
import { ServiceReference, Worker } from 'oblaka-iac'

export interface CloudflareProxyWorkerOptions {
	/** Name of the proxy Worker before the environment prefix is applied by oblaka. */
	readonly name: string
	/** The application Worker. It must not have a public route of its own. */
	readonly app: Worker
	/** IAM application id used to mint and verify the upstream token. */
	readonly appId: string
	/** Host matched by the proxy manifest. Use the public custom domain when one exists. */
	readonly appHost: string
	/** Ordered gate rules evaluated by the shared proxy authorizer. */
	readonly gates: AppGates
	/** Optional Cloudflare custom domain for the proxy Worker. */
	readonly domain?: string
	/** IAM service name. The global default is the platform IAM Worker. */
	readonly iamService?: string
	/** IAM origin used for login redirects and token issuer validation. */
	readonly iamUrl?: string
}

/**
 * Build the Cloudflare side of the accepted proxy topology: the public Worker owns the route and
 * binds the private application Worker. IAM remains a global service binding.
 */
export function createCloudflareProxyWorker(options: CloudflareProxyWorkerOptions): Worker {
	if ((options.app.options.routes?.length ?? 0) > 0) {
		throw new Error(`cloudflare proxy app \`${options.app.options.name}\` must not declare public routes`)
	}
	if (options.app.options.workers_dev !== false) {
		throw new Error(`cloudflare proxy app \`${options.app.options.name}\` must disable workers.dev`)
	}
	if (options.appHost.trim() === '') {
		throw new Error('cloudflare proxy appHost must be non-empty')
	}

	const local = options.appHost === 'localhost'
	const manifest: ProxyManifest = {
		apps: [{
			id: options.appId,
			hosts: local ? ['localhost', '127.0.0.1'] : [options.appHost],
			upstream: 'APP',
			gates: options.gates,
			// Cloudflare terminates TLS at the edge and a route is always https; only a localhost
			// binding is reached over plain HTTP.
			scheme: local ? 'http' : 'https',
		}],
	}
	const domain = options.domain?.trim()

	return new Worker({
		dir: import.meta.dir,
		name: options.name,
		main: './proxy-worker.ts',
		compatibility_flags: ['nodejs_compat'],
		compatibility_date: '2025-05-25',
		routes: domain === undefined || domain === '' ? [] : [{ pattern: domain, custom_domain: true }],
		observability: { logs: { enabled: true, invocation_logs: false } },
		vars: {
			FABRIKA_PROXY_MANIFEST_JSON: encodeProxyManifestJson(manifest),
			FABRIKA_IAM_URL: options.iamUrl ?? '',
		},
		bindings: {
			IAM: new ServiceReference(options.iamService ?? 'propustka-worker'),
			APP: options.app,
		},
	})
}
