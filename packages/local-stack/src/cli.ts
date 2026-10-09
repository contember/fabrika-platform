import { rmSync } from 'node:fs'
import { compose } from './compose'
import { STATE_DIR } from './prepare'
import { upLocalComposition } from './up'

const command = Bun.argv[2] ?? ''

try {
	if (command === 'up') {
		await upLocalComposition()
	} else if (command === 'status') {
		await compose(['ps'])
	} else if (command === 'down') {
		await compose(['down', '--remove-orphans'])
	} else if (command === 'reset') {
		await compose(['down', '--volumes', '--remove-orphans'])
		rmSync(STATE_DIR, { recursive: true, force: true })
		await upLocalComposition()
	} else {
		throw new Error('usage: bun src/cli.ts <up|status|reset|down>')
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : 'local stack command failed')
	process.exit(1)
}
