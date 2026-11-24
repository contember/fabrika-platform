// The `/mcp` route of the Cloudflare Worker (ADR-0049 rule 9): the same handler the Bun process mounts, composed per
// request from that request's env and provider, as every other route of the Worker is.

import type { McpRoute } from '../app'
import type { Env } from '../env'
import { githubWorkspaceSource } from '../github/workspace'
import type { WorkspaceSourcePort } from '../workspace-source-port'
import { type AppRules, exactPinSatisfies, parseAppAgentSkill } from './app-rules'
import { controlMcpRoute } from './route'

/**
 * The route over the skill the deploy embedded (`fabrika.config.ts` writes it only with the MCP table), or null without
 * one. The skill is parsed on the first request, so a broken one fails `/mcp` alone, never the console's boot.
 */
export function workerMcpRoute(
	embeddedSkill: string | undefined,
	/** Overridable for tests; production reaches GitHub through the app's connection. */
	workspaceSource: (env: Env) => WorkspaceSourcePort = (env) => githubWorkspaceSource(env),
): McpRoute | null {
	if (embeddedSkill === undefined) return null
	let rules: AppRules | undefined
	return (request, ctx) => {
		rules ??= { skill: parseAppAgentSkill(embeddedSkill), satisfies: exactPinSatisfies }
		return controlMcpRoute(ctx.env, workspaceSource(ctx.env), ctx.provider, rules)(request)
	}
}
