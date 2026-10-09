import { compileContract, schemaFromContract } from '@fabrika/app/contract'
import { appEnvironmentId, contractDigest, FABRIKA_CONTRACT_DIGEST, FABRIKA_IAM_APP_ID, FABRIKA_IAM_ISSUER } from '@fabrika/auth-core'
import { createCloudflareProxyWorker, defineApp, iamServiceReference, type ResourceContext, Worker } from '@fabrika/provider-cloudflare'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { contract } from './fabrika.contract'

export const exampleAppId = contract.vocabulary.app

/** No `@fabrika/db` on Cloudflare, so the contract compiles without table policies. */
export const exampleArtifact = compileContract(contract, {})

export const buildExampleWorker = (): Worker =>
	new Worker({
		dir: '.',
		name: 'propustka-example-app',
		main: './fabrika/entry.generated.ts',
		compatibility_flags: ['nodejs_compat_v2'],
		compatibility_date: '2025-10-01',
		observability: { enabled: true },
		workers_dev: false,
		preview_urls: false,
		// Public routing belongs to the proxy Worker. The application is reached through its APP service binding.
		routes: [],
		bindings: {
			// IAM's application entrypoint: token verification, the people directory, audit. No key issuing.
			IAM: iamServiceReference(),
		},
		// No `FABRIKA_*` variable here: every deploy writes the issuer, the audience and the contract digest into this
		// Worker (ADR-0035), and a config that declares one is refused.
	})

/** Where `bun run dev` in `packages/iam` serves IAM, the issuer of the local run's tokens. */
export const LOCAL_IAM_ORIGIN = 'http://localhost:18191'

/**
 * The proxy + app composition for a local run (`oblaka.ts`, lopata). A deploy never takes it: the deployer builds the
 * proxy Worker from the contract it reads in the checkout (ADR-0048) and writes the framework variables itself.
 */
export const buildExampleProxy = (ctx: ResourceContext): Worker => {
	const iamUrl = LOCAL_IAM_ORIGIN
	// The proxy mints for this environment's IAM application id, the audience the application verifies.
	const appId = appEnvironmentId(exampleAppId, ctx.env)
	const app = buildExampleWorker()
	return createCloudflareProxyWorker({
		name: 'propustka-example-proxy',
		app: new Worker({
			...app.options,
			vars: { [FABRIKA_IAM_ISSUER]: iamUrl, [FABRIKA_IAM_APP_ID]: appId, [FABRIKA_CONTRACT_DIGEST]: contractDigest(exampleArtifact) },
		}),
		appId,
		appHost: ctx.domain ?? 'localhost',
		domain: ctx.domain,
		endpoints: contractProxyTable(exampleArtifact),
		iamUrl,
	})
}

export default defineApp({
	id: exampleAppId,
	resources: buildExampleWorker,
	// `contract: true` makes IAM refuse every wildcard written for this application.
	schema: schemaFromContract(exampleArtifact),
	pipeline: {
		workerDir: '.',
	},
})
