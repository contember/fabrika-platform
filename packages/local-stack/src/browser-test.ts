import { resetBrowserStack, stopBrowserStack } from './browser-support'
import { REPO_ROOT } from './prepare'

let exitCode = 1
try {
	await resetBrowserStack()
	const test = Bun.spawn(['bunx', 'opice', 'test', '--path-ignore-patterns=__opice-no-ignore__', 'tests/browser', ...Bun.argv.slice(2)], {
		cwd: REPO_ROOT,
		env: { ...process.env, OPICE_AUTH_REFRESH: '1' },
		stdin: 'inherit',
		stdout: 'inherit',
		stderr: 'inherit',
	})
	exitCode = await test.exited
} catch (error) {
	console.error(error instanceof Error ? error.message : 'browser test run failed')
} finally {
	try {
		await stopBrowserStack({ volumes: true })
	} catch (error) {
		console.error(error instanceof Error ? error.message : 'browser stack cleanup failed')
		exitCode = 1
	}
}

process.exit(exitCode)
