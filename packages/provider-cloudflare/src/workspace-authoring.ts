// MCP authoring on Cloudflare (ADR-0049 rule 9): what an authoring target of this provider is offered.
//
// Kept clear of `oblaka-iac`: `control.ts`, the `./runner` entry, imports it.

import type { ProviderAuthoring } from '@fabrika/provider-contract'

/**
 * The capability flag `deploy_stage` waits for. A Cloudflare deploy runs the checkout's code in the runner container,
 * beside the account-wide API token (backlog 86). A workspace commit is unreviewed and written by an agent, so it may
 * reach that container only once the runner builds it in a step that holds no credential, and the credentialed step
 * deploys the built bundle without running the checkout's code. The runner change that does so sets this to `true`.
 * Until then Control refuses `deploy_stage` on Cloudflare with `CLOUDFLARE_STAGE_DEPLOY_REFUSAL`; every other
 * authoring tool, `apply_changes` and `create_pull_request` among them, is served.
 */
export const CLOUDFLARE_ISOLATED_BUILD: boolean = true

/** The repository files that configure a Cloudflare deploy beside `fabrika.config.ts`, protected at any depth (ADR-0049 rule 6). */
export const CLOUDFLARE_PROTECTED_FILES: readonly string[] = ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml']

/** The tool error an agent reads from `deploy_stage` while the runner builds a workspace commit beside the account token. */
export const CLOUDFLARE_STAGE_DEPLOY_REFUSAL = 'deploy_stage is not available on this Cloudflare installation yet: its deploy runner '
	+ "does not build an unreviewed commit apart from the installation's Cloudflare credential. Your commits are on the "
	+ 'workspace branch; open a pull request with create_pull_request, and a person reviews, merges and deploys it.'

/** The authoring declaration of the Cloudflare control provider, by whether the runner builds a workspace commit in isolation. */
export const cloudflareAuthoring = (isolatedBuild: boolean = CLOUDFLARE_ISOLATED_BUILD): ProviderAuthoring => ({
	protectedFiles: CLOUDFLARE_PROTECTED_FILES,
	...(isolatedBuild ? {} : { stageDeployRefusal: CLOUDFLARE_STAGE_DEPLOY_REFUSAL }),
})
