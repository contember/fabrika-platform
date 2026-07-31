import { resetBrowserStack, startBrowserStack, stopBrowserStack } from './browser-support'

const command = Bun.argv[2] ?? ''

try {
	if (command === 'up') {
		await startBrowserStack()
	} else if (command === 'reset') {
		await resetBrowserStack()
	} else if (command === 'down') {
		await stopBrowserStack({ volumes: Bun.argv.includes('--volumes') })
	} else {
		throw new Error('usage: bun src/browser-cli.ts <up|reset|down> [--volumes]')
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : 'browser stack command failed')
	process.exit(1)
}
