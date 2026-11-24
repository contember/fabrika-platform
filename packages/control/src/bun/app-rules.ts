import { readAppAgentSkill } from '@fabrika/app/agent-skill'
import type { AppRules } from '../mcp/app-rules'

/** The process reads `get_app_rules` from the installed `@fabrika/app` and compares a workspace's pin with Bun's semver. */
export function processAppRules(): AppRules {
	return { skill: readAppAgentSkill(), satisfies: (version, range) => Bun.semver.satisfies(version, range) }
}
