import { expect, test } from 'bun:test'
import { confirm } from '../prompt'
import { childStdin } from '../shell'

test('a TTY child inherits stdin, a child with no terminal gets none, and an explicit stdin still wins', () => {
	const step = { command: 'gh', args: ['repo', 'view'], cwd: '.' }
	expect(childStdin(step, true)).toBe('inherit')
	expect(childStdin(step, false)).toBe('ignore')
	// `gh secret set` reads the VALUE from stdin; that has never come from the operator's terminal.
	expect(childStdin({ ...step, stdin: 'a-value' }, false)).toBeInstanceOf(Uint8Array)
})

test('a confirmation without a terminal fails and names --yes instead of waiting for an answer', async () => {
	if (process.stdin.isTTY === true) return
	await expect(confirm('Proceed?', true)).rejects.toThrow('pass --yes')
})
