// What a PIPED stdin must do to the prompts, which is what makes `platform init` scriptable.
//
// The bug these pin: a readline closed after every question discards whatever it had already buffered,
// so a command driven by `printf 'a\nb\nc\n' | …` answered question 1 and then waited forever for an
// answer that had already arrived and been thrown away. Nothing about it is visible on a TTY, where a
// human supplies one line at a time.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { pipedPrompt } from '../prompt'
import { childStdin } from '../shell'

/** A stdin that is not a terminal, and the stdout the prompts are written to. */
const streams = (): { input: PassThrough; output: PassThrough; written(): string } => {
	const input = new PassThrough()
	const output = new PassThrough()
	const chunks: string[] = []
	output.on('data', (chunk: Buffer) => void chunks.push(chunk.toString()))
	return { input, output, written: () => chunks.join('') }
}

describe('one reader over a piped stdin', () => {
	test('answers every question from a single write, in order', async () => {
		const { input, output, written } = streams()
		const prompt = pipedPrompt(input, output)
		input.write('contember/sidecar\nv1.2.3\nproj-1\n')

		expect(await prompt.ask('Repository: ')).toBe('contember/sidecar')
		expect(await prompt.ask('Tag: ')).toBe('v1.2.3')
		expect(await prompt.ask('Project: ')).toBe('proj-1')
		// Every question is still written out, so a piped run leaves the same transcript a terminal does.
		expect(written()).toContain('Repository: ')
		expect(written()).toContain('Tag: ')
		expect(written()).toContain('Project: ')
	})

	test('takes an answer that has not arrived yet', async () => {
		const { input, output } = streams()
		const prompt = pipedPrompt(input, output)

		const answer = prompt.ask('Project: ')
		input.write('proj-2\n')

		expect(await answer).toBe('proj-2')
	})

	test('keeps a blank line blank, so a prompt with a default still gets one', async () => {
		const { input, output } = streams()
		const prompt = pipedPrompt(input, output)
		input.write('\nsecond\n')

		expect(await prompt.ask('Region: ')).toBe('')
		expect(await prompt.ask('Next: ')).toBe('second')
	})

	test('raises when the stream ends with a question unanswered, instead of hanging on it', async () => {
		const { input, output } = streams()
		const prompt = pipedPrompt(input, output)
		input.write('only-one\n')
		input.end()

		expect(await prompt.ask('First: ')).toBe('only-one')
		await expect(prompt.ask('Second: ')).rejects.toThrow('stdin ended before `Second` was answered')
	})

	test('raises on a stream that ends while a question is already waiting', async () => {
		const { input, output } = streams()
		const prompt = pipedPrompt(input, output)

		const pending = prompt.ask('First: ')
		input.end()

		await expect(pending).rejects.toThrow('a piped run must supply one line per question')
	})

	test('flushes a last line that never got its newline', async () => {
		const { input, output } = streams()
		const prompt = pipedPrompt(input, output)
		input.write('first\nno-trailing-newline')
		input.end()

		expect(await prompt.ask('One: ')).toBe('first')
		expect(await prompt.ask('Two: ')).toBe('no-trailing-newline')
	})

	test('names the question a secret asked for, whose own query is empty', async () => {
		const { input, output } = streams()
		const prompt = pipedPrompt(input, output)
		input.end()

		await expect(prompt.ask('', 'Zerops access token')).rejects.toThrow('stdin ended before `Zerops access token` was answered')
	})

	test('fails the pending question when the stream faults, instead of waiting on it forever', async () => {
		const { input, output } = streams()
		const prompt = pipedPrompt(input, output)

		const pending = prompt.ask('First: ')
		input.destroy(new Error('EIO: i/o error'))

		await expect(pending).rejects.toThrow('stdin could not be read: EIO: i/o error')
	})

	test('refuses two questions at once — one stream, one queue, one reader', async () => {
		const { input, output } = streams()
		const prompt = pipedPrompt(input, output)

		const first = prompt.ask('First: ')
		await expect(prompt.ask('Second: ')).rejects.toThrow('a question is already waiting')
		input.write('one\n')
		expect(await first).toBe('one')
	})
})

describe('a child process spawned between two questions', () => {
	const DRIVER = resolve(import.meta.dir, 'fixtures/piped-driver.ts')

	test('does not eat the answers the reader has not drained yet', async () => {
		// The real shape of the bug, with a SLOW producer: the second answer is written while the child is
		// running, so a child that inherited stdin would consume it and the second question would die on a
		// stream that ended. Every write is ordered against a marker the driver prints, so nothing races —
		// and ONE reader holds the driver's stdout throughout, or the driver takes an EPIPE mid-prompt.
		const proc = Bun.spawn(['bun', DRIVER], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
		const reader = proc.stdout.getReader()
		const decoder = new TextDecoder()
		let transcript = ''
		const until = async (marker: string): Promise<void> => {
			while (!transcript.includes(marker)) {
				const { done, value } = await reader.read()
				if (done) {
					return
				}
				transcript += decoder.decode(value, { stream: true })
			}
		}

		proc.stdin.write('one\n')
		await proc.stdin.flush()
		await until('FIRST:one')
		// Written while the child holds the terminal, and never read by anything but the next question.
		proc.stdin.write('two\n')
		await proc.stdin.end()
		await until('SECOND:two')
		reader.releaseLock()

		expect(await proc.exited).toBe(0)
		expect(transcript).toContain('CHILD-DONE')
		expect(transcript).toContain('SECOND:two')
	}, 15000)

	test('a TTY child still inherits it, and an explicit stdin still wins', () => {
		const step = { command: 'gh', args: ['repo', 'view'], cwd: '.' }
		expect(childStdin(step, true)).toBe('inherit')
		expect(childStdin(step, false)).toBe('ignore')
		// `gh secret set` reads the VALUE from stdin; that has never come from the operator's terminal.
		expect(childStdin({ ...step, stdin: 'a-value' }, false)).toBeInstanceOf(Uint8Array)
	})
})
