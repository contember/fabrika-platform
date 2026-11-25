// What `get_app_rules` answers (ADR-0049): the skill of `@fabrika/app`, which the composition root supplies. The Bun
// process reads it from the package; a Worker has no file system, so its deploy embeds the skill in the bundle.

import { z } from 'zod/v4'

/**
 * The part of `@fabrika/app/agent-skill`'s `AppAgentSkill` the tool answers, declared here so the Worker graph names
 * no module that reads files.
 */
export interface AppRulesSkill {
	readonly version: string
	readonly body: string
	readonly references: readonly { readonly topic: string; readonly text: string }[]
}

export interface AppRules {
	readonly skill: AppRulesSkill
	/** Whether `version` satisfies the workspace's semver `range`; null when this runtime cannot tell, and no warning is given. */
	readonly satisfies: (version: string, range: string) => boolean | null
}

const appAgentSkillSchema = z.object({
	version: z.string().min(1),
	body: z.string(),
	references: z.array(z.object({ topic: z.string().min(1), text: z.string() })),
})

/** The skill a deploy embedded as JSON; anything else is refused, so a console never answers rules it cannot read. */
export function parseAppAgentSkill(json: string): AppRulesSkill {
	let value: unknown
	try {
		value = JSON.parse(json)
	} catch {
		throw new Error('the embedded @fabrika/app skill is not valid JSON')
	}
	const parsed = appAgentSkillSchema.safeParse(value)
	if (!parsed.success) throw new Error('the embedded @fabrika/app skill is not a skill')
	return parsed.data
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** Without a semver range parser (a Worker), only an exact pin is judged: equal satisfies, another version does not. */
export function exactPinSatisfies(version: string, range: string): boolean | null {
	const pinned = range.trim().replace(/^[=v]/, '')
	return EXACT_VERSION.test(pinned) ? pinned === version : null
}

/** The identifier wrangler replaces with the skill's JSON in a Worker that serves MCP (`src/index.ts`, `fabrika.config.ts`). */
export const APP_AGENT_SKILL_DEFINE = '__FABRIKA_APP_AGENT_SKILL__'
