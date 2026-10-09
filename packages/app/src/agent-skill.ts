// @fabrika/app/agent-skill — the one source of the rules every agent that writes an application reads: the builder
// installs `skill/SKILL.md` as a skill, Control's MCP server sends its body as instructions, and the template's
// AGENTS.md is `renderAgentsFile`. Reads a file of this package, so only Bun or Node code imports it.

import { readFileSync } from 'node:fs'

export const APP_AGENT_SKILL_NAME = 'fabrika-app'

const SKILL_FILE = new URL('../skill/SKILL.md', import.meta.url)
const FRONTMATTER = /^---\n[\s\S]*?\n---\n+/

export interface AppAgentSkill {
	/** The whole `SKILL.md`, frontmatter included: what a skill directory holds. */
	readonly text: string
	/** The rules without the frontmatter. */
	readonly body: string
}

export function readAppAgentSkill(): AppAgentSkill {
	const text = readFileSync(SKILL_FILE, 'utf-8')
	const frontmatter = FRONTMATTER.exec(text)
	if (frontmatter === null) throw new Error('@fabrika/app: skill/SKILL.md has no frontmatter')
	return { text, body: text.slice(frontmatter[0].length) }
}

/** The `AGENTS.md` of an application repository. */
export function renderAgentsFile(skill: AppAgentSkill): string {
	return `<!-- Generated from skill/SKILL.md of @fabrika/app. Change that file, not this one. -->\n\n${skill.body}`
}
