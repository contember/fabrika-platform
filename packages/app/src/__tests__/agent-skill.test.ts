import { describe, expect, test } from 'bun:test'
import { APP_AGENT_SKILL_NAME, readAppAgentSkill, renderAgentsFile } from '../agent-skill'

describe('the agent skill', () => {
	test('is a skill file whose name is the directory the builder installs it under', () => {
		const { text, body } = readAppAgentSkill()
		const frontmatter = text.slice(0, text.length - body.length)
		expect(frontmatter).toStartWith('---\n')
		expect(frontmatter).toContain(`\nname: ${APP_AGENT_SKILL_NAME}\n`)
		expect(frontmatter).toContain('\ndescription: >\n')
		expect(body).toStartWith('# Fabrika application rules\n')
		expect(body).not.toContain('\n---\n')
	})

	test('the AGENTS.md of an application is the skill body under a generated-file marker', () => {
		const skill = readAppAgentSkill()
		const agents = renderAgentsFile(skill)
		expect(agents).toEndWith(skill.body)
		expect(agents.slice(0, agents.length - skill.body.length)).toBe(
			'<!-- Generated from skill/SKILL.md of @fabrika/app. Change that file, not this one. -->\n\n',
		)
	})
})
