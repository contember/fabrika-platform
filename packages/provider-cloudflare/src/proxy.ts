import type { AppGates } from '@fabrika/auth'
import { type ContractProxyTable, encodeProxyManifestJson, type ProxyApp, type ProxyManifest } from '@fabrika/proxy-core/manifest'
import { ServiceReference, Worker } from 'oblaka-iac'

interface CloudflareProxyWorkerBase {
	/** Name of the proxy Worker before the environment prefix is applied by oblaka. */
	readonly name: string
	/** The application Worker. It must not have a public route of its own. */
	readonly app: Worker
	/** IAM application id used to mint and verify the upstream token. */
	readonly appId: string
	/** Host matched by the proxy manifest. Use the public custom domain when one exists. */
	readonly appHost: string
	/** Optional Cloudflare custom domain for the proxy Worker. */
	readonly domain?: string
	/** IAM service name. The global default is the platform IAM Worker. */
	readonly iamService?: string
	/** IAM origin used for login redirects and token issuer validation. */
	readonly iamUrl?: string
}

interface CloudflareContractProxyOptions {
	readonly endpoints: ContractProxyTable
	readonly gates?: never
	/** The Operations ingest origin a contract application's `connect-src` admits, from its managed DSN. */
	readonly operationsOrigin?: string
}

/**
 * What the proxy enforces: a contract application's endpoint table (`contractProxyTable(artifact)`), or the ordered
 * gates of an installation service. Never both.
 */
export type CloudflareProxyWorkerOptions =
	| (CloudflareProxyWorkerBase & CloudflareContractProxyOptions)
	| (CloudflareProxyWorkerBase & { readonly gates: AppGates; readonly endpoints?: never })

/** Where `createCloudflareProxyWorker` points its Worker: the deployer builds every application's proxy from here. */
export const CLOUDFLARE_PROXY_WORKER_DIR: string = import.meta.dir
export const CLOUDFLARE_PROXY_WORKER_MAIN = './proxy-worker.ts'

/** IAM's Worker: the one platform service an application binds, and only through the entrypoint below. */
export const IAM_SERVICE = 'propustka-worker'

/** IAM's narrow `WorkerEntrypoint`, which carries neither key issuing nor device approval (`packages/iam/src/index.ts`). */
export const IAM_APPLICATION_ENTRYPOINT = 'PropustkaApplication'

/** The `IAM` binding of an application Worker; a generated config that binds IAM any other way is refused. */
export const iamServiceReference = (): ServiceReference => new ServiceReference(IAM_SERVICE, IAM_APPLICATION_ENTRYPOINT)

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
	const placement = {
		id: options.appId,
		hosts: local ? ['localhost', '127.0.0.1'] : [options.appHost],
		upstream: 'APP',
		// Cloudflare terminates TLS at the edge and a route is always https; only a localhost
		// binding is reached over plain HTTP.
		scheme: local ? 'http' : 'https',
	} satisfies Omit<ProxyApp, 'gates' | 'endpoints'>
	const manifest: ProxyManifest = { apps: [proxyApp(placement, options)] }
	const domain = options.domain?.trim()

	return new Worker({
		dir: CLOUDFLARE_PROXY_WORKER_DIR,
		name: options.name,
		main: CLOUDFLARE_PROXY_WORKER_MAIN,
		compatibility_flags: ['nodejs_compat'],
		compatibility_date: '2025-05-25',
		routes: domain === undefined || domain === '' ? [] : [{ pattern: domain, custom_domain: true }],
		observability: { logs: { enabled: true, invocation_logs: false } },
		vars: {
			FABRIKA_PROXY_MANIFEST_JSON: encodeProxyManifestJson(manifest),
			FABRIKA_IAM_ISSUER: options.iamUrl ?? '',
		},
		bindings: {
			IAM: new ServiceReference(options.iamService ?? IAM_SERVICE, IAM_APPLICATION_ENTRYPOINT),
			APP: options.app,
		},
	})
}

function proxyApp(placement: Omit<ProxyApp, 'gates' | 'endpoints'>, options: CloudflareProxyWorkerOptions): ProxyApp {
	if (options.endpoints !== undefined && options.gates !== undefined) {
		throw new Error("cloudflare proxy carries a contract application's endpoint table or gates, never both")
	}
	if (options.endpoints !== undefined) {
		const { endpoints, reservedPrefixes, snapshot, csp } = options.endpoints
		const operationsOrigin = options.operationsOrigin
		return { ...placement, endpoints, reservedPrefixes, snapshot, csp, ...(operationsOrigin === undefined ? {} : { operationsOrigin }) }
	}
	return { ...placement, gates: options.gates }
}
