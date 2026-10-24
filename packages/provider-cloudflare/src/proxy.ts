import {
	contractProxyEntry,
	type ContractProxyTable,
	encodeProxyManifestJson,
	type InstallationProxyTable,
	type ProxyApp,
	type ProxyManifest,
} from '@fabrika/proxy-core/manifest'
import { ServiceReference, Worker } from 'oblaka-iac'

/** A binding as oblaka configures it into a Worker's generated config. */
type Binding = Pick<ServiceReference, 'configureBinding'>

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
	readonly installation?: never
	/** The Operations ingest origin a contract application's `connect-src` admits, from its managed DSN. */
	readonly operationsOrigin?: string
	/** The origins the environment lists for its cross-origin endpoints, from Control's registry (ADR-0022). */
	readonly crossOrigins?: readonly string[]
}

/**
 * What the proxy enforces: a contract application's endpoint table (`contractProxyTable(artifact)`) or an installation
 * service's table (`serviceProxyTable(service, …)`). Exactly one. The deployer passes only the first; `installation`
 * is written by the platform's own service configs, which is what makes the marker trusted composition (ADR-0022
 * "Installation entries").
 */
export type CloudflareProxyWorkerOptions =
	| (CloudflareProxyWorkerBase & CloudflareContractProxyOptions)
	| (CloudflareProxyWorkerBase & { readonly installation: InstallationProxyTable; readonly endpoints?: never })

/** Where `createCloudflareProxyWorker` points its Worker: the deployer builds every application's proxy from here. */
export const CLOUDFLARE_PROXY_WORKER_DIR: string = import.meta.dir
export const CLOUDFLARE_PROXY_WORKER_MAIN = './proxy-worker.ts'

/**
 * The identifier the proxy Worker's bundle reads its manifest from. The generated config's `define` replaces it with
 * the manifest as a string literal when wrangler bundles the Worker, so the table has no Worker variable's 5 KB cap.
 */
export const PROXY_MANIFEST_DEFINE = '__FABRIKA_PROXY_MANIFEST__'

/** The manifest JSON a proxy Worker built here carries, or null for any other Worker. */
export const proxyManifestJson = (worker: Worker): string | null => {
	const literal = worker.options.define?.[PROXY_MANIFEST_DEFINE]
	if (literal === undefined) return null
	const value: unknown = JSON.parse(literal)
	return typeof value === 'string' ? value : null
}

/** IAM's Worker: the one platform service an application binds, and only through the entrypoint below. */
export const IAM_SERVICE = 'propustka-worker'

/** IAM's narrow `WorkerEntrypoint`, which carries neither key issuing nor device approval (`packages/iam/src/index.ts`). */
export const IAM_APPLICATION_ENTRYPOINT = 'PropustkaApplication'

/** The `IAM` binding of an application Worker; a generated config that binds IAM any other way is refused. */
export const iamServiceReference = (): ServiceReference => new ServiceReference(IAM_SERVICE, IAM_APPLICATION_ENTRYPOINT)

/**
 * The deployer's `IAM` binding: what the Worker declared, with the IAM service entry's `props` naming the deployment's
 * IAM application id. IAM reads it as `ctx.props.app`, the transport identity of a call over the binding, as the
 * membership transport key is over HTTP (ADR-0067 §3). An application cannot choose it: the deployer writes it, and the
 * bounds refuse an IAM binding that names any other application.
 */
export class IamApplicationReference implements Binding {
	constructor(
		private readonly app: string,
		private readonly declared: Binding = iamServiceReference(),
	) {}

	configureBinding(args: Parameters<Binding['configureBinding']>[0]): ReturnType<Binding['configureBinding']> {
		const config = this.declared.configureBinding(args)
		const services = (config.services ?? []).map((entry) => entry.binding === args.binding ? { ...entry, props: { app: this.app } } : entry)
		return { ...config, services }
	}
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
	const placement = {
		id: options.appId,
		hosts: local ? ['localhost', '127.0.0.1'] : [options.appHost],
		upstream: 'APP',
		// Cloudflare terminates TLS at the edge and a route is always https; only a localhost
		// binding is reached over plain HTTP.
		scheme: local ? 'http' : 'https',
	} satisfies Pick<ProxyApp, 'id' | 'hosts' | 'upstream' | 'scheme'>
	const manifest: ProxyManifest = { apps: [proxyApp(placement, options)] }
	const domain = options.domain?.trim()

	const iam = new ServiceReference(options.iamService ?? IAM_SERVICE, IAM_APPLICATION_ENTRYPOINT)
	// An application's proxy names its application to IAM, as the application Worker's binding does; a platform
	// service's proxy is trusted composition and calls no operation that is pinned to an application.
	return new Worker({
		dir: CLOUDFLARE_PROXY_WORKER_DIR,
		name: options.name,
		main: CLOUDFLARE_PROXY_WORKER_MAIN,
		compatibility_flags: ['nodejs_compat'],
		compatibility_date: '2025-05-25',
		routes: domain === undefined || domain === '' ? [] : [{ pattern: domain, custom_domain: true }],
		observability: { logs: { enabled: true, invocation_logs: false } },
		define: { [PROXY_MANIFEST_DEFINE]: JSON.stringify(encodeProxyManifestJson(manifest)) },
		vars: { FABRIKA_IAM_ISSUER: options.iamUrl ?? '' },
		bindings: {
			IAM: options.installation === undefined ? new IamApplicationReference(options.appId, iam) : iam,
			APP: options.app,
		},
	})
}

function proxyApp(placement: Pick<ProxyApp, 'id' | 'hosts' | 'upstream' | 'scheme'>, options: CloudflareProxyWorkerOptions): ProxyApp {
	// A config written before the gates were removed is refused, never served unprotected.
	if ('gates' in options) throw new Error('cloudflare proxy: `gates` is gone; an application is protected by its endpoint table')
	if (options.installation !== undefined) {
		if (options.endpoints !== undefined) throw new Error('cloudflare proxy carries exactly one of an endpoint table or an installation table')
		const { installation, endpoints, reservedPrefixes } = options.installation
		return { ...placement, installation, endpoints, reservedPrefixes }
	}
	return contractProxyEntry({
		...placement,
		table: options.endpoints,
		...(options.operationsOrigin === undefined ? {} : { operationsOrigin: options.operationsOrigin }),
		...(options.crossOrigins === undefined ? {} : { crossOrigins: options.crossOrigins }),
	})
}
