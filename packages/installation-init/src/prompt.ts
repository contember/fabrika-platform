/**
 * Interactive prompts for the fabrika CLI, over `node:readline/promises`.
 *
 * `secret()` is the security-critical one: it reads a value WITHOUT echoing it to the terminal (no
 * keystrokes, no final value), so a token/key pasted at the prompt never lands in scrollback or a
 * screen-share. Every other prompt echoes normally. None of these functions ever log the value they
 * return — the caller routes secrets into a child-process env, never back through `log.ts`.
 *
 * ── Why stdin is read two different ways ──────────────────────────────────────────────────────────
 *
 * A PIPED stdin is read by ONE reader for the whole command. Closing a readline discards whatever it
 * has already buffered, so a fresh interface per question swallows every answer after the first and
 * the command stops on question 2 — which is what made `platform init` undrivable without a PTY.
 *
 * A TTY keeps a fresh interface per question, closed afterwards. A persistent one holds the terminal
 * in raw mode (`-icanon -echo`, measured) between questions, and `init` spawns `git` and `gh` between
 * them — a child inheriting a raw terminal echoes nothing and stair-steps its output.
 */

import { createInterface, type Interface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import { fail, info } from './log'

/** A free-text prompt. Returns the trimmed answer, or `fallback` when the operator just hits enter. */
export async function text(question: string, fallback?: string): Promise<string> {
	const suffix = fallback !== undefined && fallback !== '' ? ` [${fallback}]` : ''
	const answer = stripTerminalCruft(await ask(`${question}${suffix}: `)).trim()
	if (answer === '' && fallback !== undefined) {
		return fallback
	}
	return answer
}

/**
 * A required free-text prompt: re-asks until the operator gives a non-empty answer (or a fallback is
 * supplied and accepted). Used for values the CLI cannot proceed without.
 */
export async function required(question: string, fallback?: string): Promise<string> {
	for (;;) {
		const value = await text(question, fallback)
		if (value !== '') {
			return value
		}
		console.log('    (a value is required)')
	}
}

/**
 * A HIDDEN-ECHO prompt for secret values. Keystrokes are not echoed and the final value is not
 * printed — the line is consumed silently. The captured value is run through `stripTerminalCruft` to
 * remove bracketed-paste markers / escape sequences some terminals inject around a paste (which would
 * otherwise corrupt a pasted token), then returned. The value is NEVER logged by this module.
 */
export async function secret(question: string): Promise<string> {
	process.stdout.write(`${question}: `)
	// While reading, intercept the output stream so readline's own echo of the typed characters is
	// suppressed — only the newline at the end is allowed through, to move the cursor down.
	const muted = muteOutput()
	try {
		const answer = await ask('', question)
		return stripTerminalCruft(answer)
	} finally {
		muted.restore()
		// readline swallowed the echoed newline while muted; emit one so the next line starts fresh.
		process.stdout.write('\n')
	}
}

/**
 * Strip terminal control cruft from a captured answer: bracketed-paste markers (`ESC[200~`/`ESC[201~`),
 * any CSI/OSC escape sequence, and stray control characters. A real token / key / id / domain / email
 * never contains these, so removing them is safe — and it fixes two real cases on an interactive TTY:
 *  - a paste arriving with bracketed-paste markers embedded; and
 *  - a terminal's OSC 10/11 color-query RESPONSE leaking into a later prompt. Some CLIs (notably `gh`,
 *    via Go's termenv) query the background color with `ESC]11;?`; the terminal correctly replies with
 *    `ESC]11;rgb:RRRR/GGGG/BBBB`, but that reply can land in the next readline read. In `terminal:true`
 *    mode readline's keypress parser eats the `ESC]`, leaving the bare `11;rgb:…` payload in the line —
 *    so we strip both the full escape sequence AND that bare leftover.
 */
function stripTerminalCruft(value: string): string {
	return (
		value
			// Full OSC sequences: ESC ] … (BEL or ST). e.g. an OSC 10/11 dynamic-color response.
			// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape bytes by design.
			.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
			// Bare OSC 10/11 color responses whose ESC introducer readline's keypress parser ate
			// (`1X;rgb:RRRR/GGGG/BBBB`, optional leading `]`). Never appears in a real entered value.
			.replace(/\]?1[0-9];rgb:[0-9a-fA-F]{1,4}(?:\/[0-9a-fA-F]{1,4}){2}/g, '')
			// CSI sequences (bracketed-paste markers, cursor-position responses ESC[N;MR, SGR, …).
			// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape bytes by design.
			.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
			// Any stray C0/C1 control char + DEL.
			// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control bytes by design.
			.replace(/[\x00-\x1f\x7f]/g, '')
	)
}

/**
 * Read a secret from the environment (escape hatch / CI path) OR, failing that, the hidden prompt. If
 * `process.env[envName]` is set, its trimmed value is used and we log ONLY that the env var was the
 * source (never the value) — so an operator can pre-set e.g. `CLOUDFLARE_API_TOKEN=… bunx …` and
 * skip the interactive capture entirely (useful when the hidden prompt misbehaves on a given terminal).
 * Otherwise it falls back to `secret()`. The result is always trimmed.
 */
export async function secretOrEnv(envName: string, question: string): Promise<string> {
	const fromEnv = process.env[envName]
	if (fromEnv !== undefined && fromEnv.trim() !== '') {
		info(`Using ${envName} from the environment (not prompting).`)
		return fromEnv.trim()
	}
	return (await secret(question)).trim()
}

/** A yes/no confirmation. Defaults to `defaultYes` on an empty answer. */
export async function confirm(question: string, defaultYes = false): Promise<boolean> {
	const hint = defaultYes ? 'Y/n' : 'y/N'
	const answer = stripTerminalCruft(await ask(`${question} [${hint}]: `)).trim().toLowerCase()
	if (answer === '') {
		return defaultYes
	}
	return answer === 'y' || answer === 'yes'
}

/**
 * Run an async action that VALIDATES input (verify a token, resolve a path). On a thrown error, show
 * the message and re-ask — so a typo'd or rejected value re-prompts in place instead of crashing the
 * whole CLI and losing every value already entered. Declining the retry re-throws, so the caller's
 * top-level handler still aborts cleanly. The `action` must itself re-read its inputs (do the
 * `secret()`/`text()` prompt INSIDE it) so a retry actually asks again.
 */
export async function retry<T>(label: string, action: () => Promise<T>): Promise<T> {
	for (;;) {
		try {
			return await action()
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error))
			if (!(await confirm(`${label} — try again?`, true))) {
				throw error instanceof Error ? error : new Error(String(error))
			}
		}
	}
}

/**
 * A single-choice menu. Prints the numbered options and returns the chosen value. Re-asks on an
 * out-of-range answer. With exactly one option it returns it without prompting.
 */
export async function select<T>(question: string, options: { label: string; value: T }[]): Promise<T> {
	if (options.length === 0) {
		throw new Error('select(): no options to choose from')
	}
	const only = options[0]
	if (options.length === 1 && only !== undefined) {
		return only.value
	}
	console.log(question)
	options.forEach((opt, i) => {
		console.log(`    ${i + 1}) ${opt.label}`)
	})
	for (;;) {
		const answer = stripTerminalCruft(await ask('    choose [1]: ')).trim()
		const index = answer === '' ? 0 : Number.parseInt(answer, 10) - 1
		const chosen = options[index]
		if (chosen !== undefined) {
			return chosen.value
		}
		console.log(`    (enter a number between 1 and ${options.length})`)
	}
}

/** One command's reader over a stdin nobody is typing at. */
export interface PipedPrompt {
	/**
	 * Write `query`, then take the next line — from what is already buffered, or from what arrives.
	 * `label` names the question in a failure; `secret()` needs it because its own query is empty.
	 */
	ask(query: string, label?: string): Promise<string>
}

/**
 * A reader that OWNS the stream for the whole command, so several answers piped at once survive.
 *
 * The interface stays open, and every line it emits is queued whether or not a question is waiting for
 * it — that queue is the fix. It idles paused between questions so a finished command still exits, and
 * a stream that ends or faults raises instead of hanging forever on a question nothing will answer.
 *
 * Exported for tests, which drive it over an in-memory stream; the CLI has exactly one, over stdin.
 */
export const pipedPrompt = (input: Readable, output: Writable): PipedPrompt => {
	const rl = createInterface({ input, output, terminal: false })
	const buffered: string[] = []
	let waiting: (() => void) | undefined
	let delivered: string | undefined
	let ended = false
	let failure: Error | undefined
	const settle = (line: string | undefined): void => {
		const pending = waiting
		waiting = undefined
		delivered = line
		pending?.()
	}
	rl.on('line', (line: string) => {
		if (waiting === undefined) {
			buffered.push(line)
			return
		}
		rl.pause()
		settle(line)
	})
	rl.on('close', () => {
		ended = true
		settle(undefined)
	})
	// A read fault (EIO on a closed pty, a broken pipe) settles the pending question too. Without this
	// the promise nothing will ever resolve is the whole command's last act. BOTH objects are listened
	// to: readline re-emits the input's error, and an `error` nobody listens for on the interface is an
	// uncaught exception rather than a failed prompt.
	const faulted = (error: Error): void => {
		if (failure !== undefined) {
			return
		}
		ended = true
		failure = new Error(`stdin could not be read: ${error.message}`)
		settle(undefined)
	}
	rl.on('error', faulted)
	input.on('error', faulted)
	return {
		ask: async (query: string, label?: string): Promise<string> => {
			const named = label ?? query
			const ready = buffered.shift()
			if (ready !== undefined) {
				output.write(query)
				// Nothing echoes an answer that came off a pipe, so close the line here: a scripted run's
				// transcript reads one question per line, like the terminal one it stands in for.
				output.write('\n')
				return ready
			}
			if (ended) {
				throw failure ?? unanswered(named)
			}
			if (waiting !== undefined) {
				// One stream, one queue, one reader: two overlapping questions would race for the same line.
				throw new Error('pipedPrompt: a question is already waiting')
			}
			rl.setPrompt(query)
			rl.prompt()
			await new Promise<void>((resolve) => {
				waiting = resolve
			})
			const line = delivered
			delivered = undefined
			if (line === undefined) {
				throw failure ?? unanswered(named)
			}
			output.write('\n')
			return line
		},
	}
}

const unanswered = (label: string): Error => {
	const prompt = label.trim().replace(/:$/, '')
	return new Error(
		`stdin ended before ${prompt === '' ? 'a prompt' : `\`${prompt}\``} was answered — a piped run must supply one line per question`,
	)
}

/** The one piped reader this command has. Created on the first question, never closed by hand. */
let piped: PipedPrompt | undefined

/** Ask one question, on whichever stdin this command was given. `label` names it in a failure. */
async function ask(query: string, label?: string): Promise<string> {
	if (process.stdin.isTTY === true) {
		const rl: Interface = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
		try {
			return await rl.question(query)
		} finally {
			rl.close()
		}
	}
	piped ??= pipedPrompt(process.stdin, process.stdout)
	return piped.ask(query, label)
}

/**
 * Temporarily replace `process.stdout.write` so nothing readline echoes during a secret read reaches
 * the terminal. Returns a `restore()` that puts the original back. We only mute stdout (where the
 * echo goes); stderr is untouched so a crash still surfaces.
 */
function muteOutput(): { restore: () => void } {
	const original = process.stdout.write.bind(process.stdout)
	// Swallow everything written while muted. Typed characters and the echoed value go nowhere.
	const muted: typeof process.stdout.write = () => true
	process.stdout.write = muted
	return {
		restore: () => {
			process.stdout.write = original
		},
	}
}
