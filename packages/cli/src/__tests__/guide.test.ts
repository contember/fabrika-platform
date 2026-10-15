import { installationCli, readInstallationGuide } from '@fabrika/provider-zerops/installation'
import { describe, expect, test } from 'bun:test'
import { runCli } from '..'

const helpOf = async (argv: readonly string[]): Promise<string> => {
	const lines: string[] = []
	const info = console.info
	console.info = (message?: unknown): void => void lines.push(String(message))
	try {
		await runCli(argv)
	} finally {
		console.info = info
	}
	return lines.join('\n')
}

/** Every `fabrika …` command of the guide's code blocks, its `\` continuations joined. */
const guideCommands = (guide: string): string[] => {
	const blocks = [...guide.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1] ?? '')
	const lines = blocks.flatMap((block) => block.replaceAll(/\\\n\s*/g, ' ').split('\n'))
	const commands = lines.flatMap((line) => [...line.matchAll(/\bfabrika (platform|control|app) [^|&;]*/g)].map((match) => match[0]))
	return commands.map((command) => command.replace(/\s\d?>\s.*$/, ''))
}

/** The flags a command passes, `--help` aside: every area answers that one. */
const flagsOf = (command: string): string[] =>
	[...command.matchAll(/(?<![\w-])--([a-z][a-z-]*)/g)].map((match) => `--${match[1]}`).filter((flag) => flag !== '--help')

describe('the Zerops installation guide', () => {
	test('is what `platform guide` prints, and the usage sends a newcomer to it', async () => {
		const guide = await readInstallationGuide()
		expect(await helpOf(['platform', 'guide', '--provider=zerops'])).toBe(guide)
		expect(installationCli.usage).toContain('fabrika platform guide --provider=zerops')
		expect(await helpOf(['--help'])).toContain('fabrika platform guide --provider=zerops')
		await expect(runCli(['platform', 'guide', '--provider=zerops', '--token=secret'])).rejects.toThrow('`--token`')
	})

	test('names only commands and flags the CLI has', async () => {
		// The guide is prose beside the usage texts, so this is what keeps it from drifting silently.
		const helps = {
			platform: await helpOf(['platform', '--provider=zerops', '--help']),
			control: await helpOf(['control', '--help']),
			app: await helpOf(['--help']),
		}
		const commands = guideCommands(await readInstallationGuide())
		expect(commands.length).toBeGreaterThan(10)
		for (const command of commands) {
			const [, area = '', verb = ''] = command.split(' ')
			const help = area === 'platform' ? helps.platform : area === 'control' ? helps.control : helps.app
			const known = verb.startsWith('-') || help.includes(`fabrika ${area} ${verb}`)
			expect({ command, verb: known }).toEqual({ command, verb: true })
			for (const flag of flagsOf(command)) {
				expect({ command, flag, known: help.includes(flag) }).toEqual({ command, flag, known: true })
			}
		}
	})
})
