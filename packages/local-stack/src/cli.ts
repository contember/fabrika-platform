import { rmSync } from 'node:fs'
import { compose } from './compose'
import { ensureMachineKey } from './machine-key'
import { prepareLocalStack, STATE_DIR } from './prepare'

const command = Bun.argv[2] ?? ''

try {
	if (command === 'up') {
		await prepareLocalStack()
		await compose(['up', '--detach', '--wait', '--remove-orphans'])
		await ensureMachineKey()
	} else if (command === 'status') {
		await compose(['ps'])
	} else if (command === 'down') {
		await compose(['down', '--remove-orphans'])
	} else if (command === 'reset') {
		await compose(['down', '--volumes', '--remove-orphans'])
		rmSync(STATE_DIR, { recursive: true, force: true })
		await prepareLocalStack()
		await compose(['up', '--detach', '--wait', '--remove-orphans'])
		await ensureMachineKey()
	} else {
		throw new Error('usage: bun src/cli.ts <up|status|reset|down>')
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : 'local stack command failed')
	process.exit(1)
}
