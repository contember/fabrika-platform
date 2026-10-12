import { confirm as promptConfirm } from '@fabrika/installation-init'

/** The one question `install` and `init` ask. Injected so a flow can be exercised without a TTY. */
export interface Confirmations {
	confirm(question: string, defaultYes?: boolean): Promise<boolean>
}

/**
 * The one way a confirming command runs with nobody watching it.
 *
 * Every confirmation defaults to yes, so a pipe carrying blank lines would answer all of them with
 * nobody reading what they agree to — which is why saying yes unattended is a FLAG and never an
 * inference: it makes the choice explicit, and it puts it in the shell history of whoever ran it.
 */
export const UNATTENDED_FLAG = '--yes'

/**
 * How a command's confirmations are answered — and the refusal when nothing can answer them.
 *
 * Unattended, each question is still printed with the answer it was given, so the run leaves the same
 * record of what was agreed to that an interactive one does.
 */
export const confirmations = (
	unattended: boolean,
	stdin: { readonly isTTY?: boolean },
	announce: (line: string) => void,
	whatItDoes: string,
): Confirmations => {
	if (unattended) {
		return {
			confirm: (question) => {
				announce(`${question} yes (${UNATTENDED_FLAG})`)
				return Promise.resolve(true)
			},
		}
	}
	if (stdin.isTTY !== true) {
		throw new Error(
			`stdin is not a terminal, so nobody is here to confirm what this command does — it ${whatItDoes}. `
				+ `Run it from a terminal, or pass \`${UNATTENDED_FLAG}\` to answer every confirmation yes unattended`,
		)
	}
	return { confirm: (question, defaultYes) => promptConfirm(question, defaultYes) }
}
