// The platform proxy's manifest on AWS (the AWS idea's checklist, step 11, the commands' step): the platform's three apps
// (`generated/platform-proxy-manifest.ts`, rendered by `@fabrika/platform-artifacts` from the services' own contracts)
// on the installation's three hosts, as `installation-init` resolves them for every cloud.
//
// - **Every host on one listener.** The platform balancer sends all three hosts to the proxy's one target group on
//   :8080, and the proxy routes by host (`packages/proxy/Dockerfile`). The template's per-app ports are Zerops'
//   subdomain listeners and play no part here.
// - **Upstreams by Service Connect name**: `iam:3000`, `control:3000` and `operations:3000`, the template's own, which
//   the services publish in the platform's namespace (`services.ts`).
// - **OAuth on, as https.** IAM's public origin is the authorization server; MCP authoring is the operator's choice.
//
// The manifest is baked into the proxy's image (`images.ts`): its bytes are what the image build fetches and checks by
// their SHA-256, and the digest is part of the image's tag, so new hosts build a new image. What the services derive
// from it (the console's table digest, IAM's OAuth configuration, Operations' resource) goes to their parameters
// (`parameters.ts`) in the same run.

import {
	type DeployedServiceInput,
	platformIamOAuthConfig,
	platformOAuthResourceVerifiedBy,
	platformOrigin,
	platformProxyAppFor,
	type PlatformProxyComposition,
	platformServiceTableDigest,
	resolvePlatformProxyManifest,
} from '@fabrika/installation-init'
import { encodeProxyManifestJson } from '@fabrika/proxy-core/manifest'
import { createHash } from 'node:crypto'
import type { AwsPlatformPlan } from './apply'
import { PLATFORM_PROXY_MANIFEST_TEMPLATE } from './generated/platform-proxy-manifest'

/** The manifest an installation's proxy image is built with, and what the services derive from it. */
export interface AwsPlatformManifest {
	/** The document, as the image build fetches it. */
	readonly json: string
	/** The SHA-256 of `json`'s UTF-8 bytes, in hex: the build checks it, and the image's tag carries it. */
	readonly sha256: string
	/** What `deployedServiceEnvironment` takes from the manifest. */
	readonly deployed: Pick<DeployedServiceInput, 'controlTableDigest' | 'oauthConfig' | 'operationsOAuthResource'>
}

/** The platform proxy's manifest on the installation's hosts, `mcp` saying whether MCP authoring is on. */
export function awsPlatformManifest(plan: Pick<AwsPlatformPlan, 'hosts'>, options: { readonly mcp: boolean }): AwsPlatformManifest {
	const composition: PlatformProxyComposition = {
		scheme: 'https',
		placement: { iam: { hosts: [plan.hosts.iam] }, control: { hosts: [plan.hosts.control] }, operations: { hosts: [plan.hosts.operations] } },
		authorizationServer: platformOrigin('https', plan.hosts.iam),
		mcp: options.mcp,
	}
	const manifest = resolvePlatformProxyManifest(PLATFORM_PROXY_MANIFEST_TEMPLATE, composition)
	const json = encodeProxyManifestJson(manifest)
	const operationsOAuthResource = platformOAuthResourceVerifiedBy(PLATFORM_PROXY_MANIFEST_TEMPLATE, composition, 'operations')
	return {
		json,
		sha256: createHash('sha256').update(json, 'utf8').digest('hex'),
		deployed: {
			controlTableDigest: platformServiceTableDigest(manifest, platformProxyAppFor(PLATFORM_PROXY_MANIFEST_TEMPLATE, 'control').id),
			oauthConfig: platformIamOAuthConfig(PLATFORM_PROXY_MANIFEST_TEMPLATE, composition),
			...(operationsOAuthResource === undefined ? {} : { operationsOAuthResource }),
		},
	}
}
