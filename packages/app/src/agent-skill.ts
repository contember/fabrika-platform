// @fabrika/app/agent-skill — the one source of the rules every agent that writes an application reads: the builder
// installs `skill/` as a skill, Control's MCP server answers it from `get_app_rules`, and the template's AGENTS.md is
// `renderAgentsFile`. Reads files of a package, so only Bun or Node code imports it.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const APP_AGENT_SKILL_NAME = 'fabrika-app'

const SKILL_DIR = fileURLToPath(new URL('../skill', import.meta.url))
const SKILL_FILE = 'SKILL.md'
const REFERENCES_DIR = 'references'
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n+/
const VERSION_LINE = /^version: (\S+)$/m

export interface AppAgentSkillReference {
	/** The file's path in the skill directory, `references/<topic>.md`: the path `SKILL.md` names it by. */
	readonly path: string
	/** The topic `get_app_rules` answers it under: its file name without `.md`. */
	readonly topic: string
	readonly text: string
}

export interface AppAgentSkill {
	/** The `version` of the frontmatter: the version of the `@fabrika/app` that ships it. */
	readonly version: string
	/** The whole `SKILL.md`, frontmatter included: what a skill directory holds. */
	readonly text: string
	/** `SKILL.md` without the frontmatter. */
	readonly body: string
	/** The reference files, by path. */
	readonly references: readonly AppAgentSkillReference[]
}

/** The skill of this package. */
export function readAppAgentSkill(): AppAgentSkill {
	return readAppAgentSkillAt(SKILL_DIR)
}

/** The skill in `skillDir`, the `skill/` directory of an installed `@fabrika/app`. */
export function readAppAgentSkillAt(skillDir: string): AppAgentSkill {
	const text = readFileSync(join(skillDir, SKILL_FILE), 'utf-8')
	const frontmatter = FRONTMATTER.exec(text)
	if (frontmatter === null) throw new Error('@fabrika/app: skill/SKILL.md has no frontmatter')
	const version = VERSION_LINE.exec(frontmatter[1] ?? '')?.[1]
	if (version === undefined) throw new Error('@fabrika/app: skill/SKILL.md has no version in its frontmatter')
	const referencesDir = join(skillDir, REFERENCES_DIR)
	const names = existsSync(referencesDir) ? readdirSync(referencesDir).filter((name) => name.endsWith('.md')).sort() : []
	const references = names.map((name) => ({
		path: `${REFERENCES_DIR}/${name}`,
		topic: name.slice(0, -'.md'.length),
		text: readFileSync(join(referencesDir, name), 'utf-8'),
	}))
	return { version, text, body: text.slice(frontmatter[0].length), references }
}

/**
 * The skill of the `@fabrika/app` an application installed: the nearest `node_modules/@fabrika/app` from `appRoot`
 * up, as Bun resolves the package. `null` when the application has not installed it.
 */
export function installedAppAgentSkill(appRoot: string): AppAgentSkill | null {
	let directory = appRoot
	for (;;) {
		const skillDir = join(directory, 'node_modules', '@fabrika', 'app', 'skill')
		if (existsSync(join(skillDir, SKILL_FILE))) return readAppAgentSkillAt(skillDir)
		const parent = dirname(directory)
		if (parent === directory) return null
		directory = parent
	}
}

/** The `AGENTS.md` of an application repository: the skill's body, then each reference file. */
export function renderAgentsFile(skill: AppAgentSkill): string {
	const marker = `<!-- Generated from skill/ of @fabrika/app ${skill.version}. Change those files, not this one. -->\n\n`
	return marker + [skill.body, ...skill.references.map((reference) => reference.text)].join('\n---\n\n')
}
