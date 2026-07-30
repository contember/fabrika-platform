import { rmSync } from 'node:fs'
import { COMPOSE_FILE, prepareLocalStack, REPO_ROOT, STATE_DIR } from './prepare'

const compose = async (args: string[]): Promise<void> => {
	const process = Bun.spawn(
		['docker', 'compose', '--project-name', 'fabrika-local', '--file', COMPOSE_FILE, ...args],
		{ cwd: REPO_ROOT, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' },
	)
	const exitCode = await process.exited
	if (exitCode !== 0) {
		throw new Error(`docker compose failed with exit code ${exitCode}`)
	}
}

const command = Bun.argv[2] ?? ''

try {
	if (command === 'up') {
		await prepareLocalStack()
		await compose(['up', '--detach', '--wait', '--remove-orphans'])
	} else if (command === 'status') {
		await compose(['ps'])
	} else if (command === 'down') {
		await compose(['down', '--remove-orphans'])
	} else if (command === 'reset') {
		await compose(['down', '--volumes', '--remove-orphans'])
		rmSync(STATE_DIR, { recursive: true, force: true })
		await prepareLocalStack()
		await compose(['up', '--detach', '--wait', '--remove-orphans'])
	} else {
		throw new Error('usage: bun src/cli.ts <up|status|reset|down>')
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : 'local stack command failed')
	process.exit(1)
}
