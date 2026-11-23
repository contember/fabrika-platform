import {
	contractProxyEntry,
	type ContractProxyTable,
	encodeProxyManifestJson,
	type InstallationProxyApp,
	type InstallationProxyTable,
	parseProxyManifest,
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
	/** IAM service name, which oblaka prefixes with the env. The global default is the platform IAM Worker. */
	readonly iamService?: string
	/**
	 * IAM's Worker by its exact remote name, which an application's proxy binds whatever env it deploys in. Only an
	 * application's proxy takes it; a platform service's binds `iamService` in its own env.
	 */
	readonly iamRemoteService?: string
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
	| (CloudflareProxyWorkerBase & { readonly installation: CloudflareInstallationProxyTable; readonly endpoints?: never })

/** An installation service's table, and the OAuth resources its `oauth` rows are bound to when it has any. */
export type CloudflareInstallationProxyTable = InstallationProxyTable & Pick<InstallationProxyApp, 'oauthResources'>

/** Where `createCloudflareProxyWorker` points its Worker: the deployer builds every application's proxy from here. */
export const CLOUDFLARE_PROXY_WORKER_DIR: string = import.meta.dir
export const CLOUDFLARE_PROXY_WORKER_MAIN = './proxy-worker.ts'

/**
 * workerd's flag that keeps `process.env` empty. Without it, `nodejs_compat` from compatibility date 2025-04-01 (and
 * `POPULATE_PROCESS_ENV_FLAG` under any flag) fills it at module evaluation with the Worker's text variables and
 * secrets, for every module of the bundle to read. Both the proxy Worker and every application Worker carry it.
 */
export const NO_PROCESS_ENV_FLAG = 'nodejs_compat_do_not_populate_process_env'
/** workerd's flag that fills `process.env`; an application Worker that sets it is refused. */
export const POPULATE_PROCESS_ENV_FLAG = 'nodejs_compat_populate_process_env'
/**
 * workerd's flag that empties the `env` any module can import from `cloudflare:workers`. Without it (it has no
 * enable date at workerd 1.20260312.1), that `env` is every binding and secret of the Worker, at module evaluation and
 * at request; with it, an empty object, and `WorkerEntrypoint` and `DurableObject` still load. Both the proxy Worker
 * and every application Worker carry it.
 */
export const NO_IMPORTABLE_ENV_FLAG = 'disallow_importable_env'
/** workerd's flag that keeps the importable `env`; an application Worker that sets it is refused. */
export const IMPORTABLE_ENV_FLAG = 'allow_importable_env'

/** The flag pairs that keep the Worker's environment out of module scope: each opt-out the platform adds, and the opt-in it refuses. */
export const CLOSED_ENVIRONMENT_FLAGS: readonly { readonly closed: string; readonly opened: string; readonly what: string }[] = [
	{ closed: NO_PROCESS_ENV_FLAG, opened: POPULATE_PROCESS_ENV_FLAG, what: '`process.env`' },
	{ closed: NO_IMPORTABLE_ENV_FLAG, opened: IMPORTABLE_ENV_FLAG, what: 'the `env` of `cloudflare:workers`' },
]

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

/** Which Worker of a deployment holds an `IAM` binding: the application Worker, or the proxy Worker the platform builds. */
export type IamBindingHolder = 'application' | 'proxy'

/**
 * The `props` the deployer writes on an `IAM` binding. `app` is the deployment's IAM application id. The application
 * Worker's binding also carries `worker: 'application'`, which IAM refuses a delegation grant to (ADR-0022 rule 6). The
 * proxy's carries no mark, so a proxy deployed before the mark existed keeps obtaining grants.
 */
export const iamBindingProps = (app: string, holder: IamBindingHolder): Readonly<Record<string, string>> =>
	holder === 'application' ? { app, worker: 'application' } : { app }

/**
 * The deployer's `IAM` binding: what the Worker declared, with the IAM service entry's `props` naming the deployment's
 * IAM application id (`iamBindingProps`). IAM reads it as `ctx.props`, the transport identity of a call over the
 * binding, as the membership transport key is over HTTP (ADR-0067 §3). An application cannot choose it: the deployer
 * writes it, and the bounds refuse an IAM binding whose `props` are anything else. Repository code holding the account
 * token can still deploy past the bounds (ADR-0048, backlog 86).
 */
export class IamApplicationReference implements Binding {
	constructor(
		private readonly app: string,
		private readonly holder: IamBindingHolder,
		private readonly declared: Binding = iamServiceReference(),
		/** IAM's exact remote name, which replaces the env-prefixed one the declared binding writes; absent, that one stays. */
		private readonly remoteService?: string,
	) {}

	configureBinding(args: Parameters<Binding['configureBinding']>[0]): ReturnType<Binding['configureBinding']> {
		const config = this.declared.configureBinding(args)
		const props = iamBindingProps(this.app, this.holder)
		const service = this.remoteService === undefined ? {} : { service: this.remoteService }
		const services = (config.services ?? []).map((entry) => entry.binding === args.binding ? { ...entry, ...service, props } : entry)
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
	// The Worker parses the same document at its first request: one the parser refuses fails the deploy instead.
	if (parseProxyManifest(manifest) === null) throw new Error(`cloudflare proxy \`${options.name}\` carries a manifest the proxy refuses`)
	const domain = options.domain?.trim()

	const iam = new ServiceReference(options.iamService ?? IAM_SERVICE, IAM_APPLICATION_ENTRYPOINT)
	// An application's proxy names its application to IAM, as the application Worker's binding does; a platform
	// service's proxy is trusted composition and calls no operation that is pinned to an application.
	return new Worker({
		dir: CLOUDFLARE_PROXY_WORKER_DIR,
		name: options.name,
		main: CLOUDFLARE_PROXY_WORKER_MAIN,
		compatibility_flags: ['nodejs_compat', ...CLOSED_ENVIRONMENT_FLAGS.map(({ closed }) => closed)],
		compatibility_date: '2025-05-25',
		routes: domain === undefined || domain === '' ? [] : [{ pattern: domain, custom_domain: true }],
		observability: { logs: { enabled: true, invocation_logs: false } },
		define: { [PROXY_MANIFEST_DEFINE]: JSON.stringify(encodeProxyManifestJson(manifest)) },
		vars: { FABRIKA_IAM_ISSUER: options.iamUrl ?? '' },
		bindings: {
			IAM: options.installation === undefined ? new IamApplicationReference(options.appId, 'proxy', iam, options.iamRemoteService) : iam,
			APP: options.app,
		},
	})
}

function proxyApp(placement: Pick<ProxyApp, 'id' | 'hosts' | 'upstream' | 'scheme'>, options: CloudflareProxyWorkerOptions): ProxyApp {
	// A config written before the gates were removed is refused, never served unprotected.
	if ('gates' in options) throw new Error('cloudflare proxy: `gates` is gone; an application is protected by its endpoint table')
	if (options.installation !== undefined) {
		if (options.endpoints !== undefined) throw new Error('cloudflare proxy carries exactly one of an endpoint table or an installation table')
		const { installation, endpoints, reservedPrefixes, oauthResources } = options.installation
		return { ...placement, installation, endpoints, reservedPrefixes, ...(oauthResources === undefined ? {} : { oauthResources }) }
	}
	return contractProxyEntry({
		...placement,
		table: options.endpoints,
		...(options.operationsOrigin === undefined ? {} : { operationsOrigin: options.operationsOrigin }),
		...(options.crossOrigins === undefined ? {} : { crossOrigins: options.crossOrigins }),
	})
}
