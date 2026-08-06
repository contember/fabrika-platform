/**
 * Progress reporting for `fabrika platform deploy --provider=zerops`.
 *
 * HARD RULE, the same one `@fabrika/installation-cloudflare`'s `log.ts` states: **nothing here ever
 * prints a secret VALUE, and there is deliberately no helper that accepts one.** Callers may pass a
 * variable NAME, a count, or a "✓ written" confirmation. The Zerops access token and the IAM
 * provisioning key are the two credentials this command holds; neither has a formatting path.
 *
 * A caught error is never passed through here either — `@fabrika/provider-zerops`'s `ZeropsApiError`
 * already redacts the platform's message on the calls that carry a value, but a raw error from
 * anywhere else may quote a URL with an embedded token. Log a short sentence, never an error object.
 */

/** Where the command's progress goes. Injected so a test can read the transcript instead of stdout. */
export interface DeployLog {
	/** A numbered stage of the sequence. */
	step(title: string): void
	/** A detail line under the current stage. */
	info(message: string): void
	/** Something the operator should notice but which does not stop the deploy. */
	warn(message: string): void
}

/** The real console log. Stateful only in its step counter. */
export const consoleDeployLog = (): DeployLog => {
	let step = 0
	return {
		step(title: string): void {
			step += 1
			console.info(`\n[${step}] ${title}`)
		},
		info(message: string): void {
			console.info(`    ${message}`)
		},
		warn(message: string): void {
			console.warn(`    ! ${message}`)
		},
	}
}

/** A log that records every line, for tests and for `--dry-run` assertions. */
export const recordingDeployLog = (): DeployLog & { readonly lines: readonly string[] } => {
	const lines: string[] = []
	return {
		lines,
		step: (title) => void lines.push(`step: ${title}`),
		info: (message) => void lines.push(`info: ${message}`),
		warn: (message) => void lines.push(`warn: ${message}`),
	}
}
