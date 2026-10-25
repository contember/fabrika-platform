/**
 * The one interactive question the fabrika CLI asks: a yes/no confirmation before a step that leaves
 * the operator's machine. Every other input is a flag or an environment variable, and a run with no
 * terminal answers confirmations with `--yes` (`confirmations.ts`), so this reads a TTY only.
 *
 * A fresh interface per question, closed afterwards: a persistent one holds the terminal in raw mode
 * (`-icanon -echo`, measured) between questions, and init spawns `git` and `gh` between them — a child
 * inheriting a raw terminal echoes nothing and stair-steps its output.
 */

import { createInterface } from 'node:readline/promises'

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
			// oxlint-disable-next-line no-control-regex -- matching terminal escape bytes by design.
			.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
			// Bare OSC 10/11 color responses whose ESC introducer readline's keypress parser ate
			// (`1X;rgb:RRRR/GGGG/BBBB`, optional leading `]`). Never appears in a real entered value.
			.replace(/\]?1[0-9];rgb:[0-9a-fA-F]{1,4}(?:\/[0-9a-fA-F]{1,4}){2}/g, '')
			// CSI sequences (bracketed-paste markers, cursor-position responses ESC[N;MR, SGR, …).
			// oxlint-disable-next-line no-control-regex -- matching terminal escape bytes by design.
			.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
			// Any stray C0/C1 control char + DEL.
			// oxlint-disable-next-line no-control-regex -- matching terminal control bytes by design.
			.replace(/[\x00-\x1f\x7f]/g, '')
	)
}

async function ask(query: string): Promise<string> {
	if (process.stdin.isTTY !== true) {
		throw new Error('a confirmation needs a terminal; pass --yes to answer every confirmation unattended')
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
	try {
		return await rl.question(query)
	} finally {
		rl.close()
	}
}
