// The block `platform admin` and `platform init` both end with: what `fabrika control key issue`
// needs, and where an operator goes to find each part of it.
//
// It lives here, in the Zerops package rather than in `@fabrika/installation-init`, because only the
// PLACES are worth printing and every place is Zerops-shaped — a service's env in a Zerops project,
// the sidecar repository's Environment. The variable names are IAM's, but a Cloudflare installation
// would have to name entirely different locations for them.
//
// ── It is PASTEABLE, which decides its shape ──────────────────────────────────────────────────────
//
// The acceptance is a fresh shell holding nothing: paste the block, supply the two keys, mint a key on
// the first try. So the origin is an `export` — a bare `NAME=value` sets a shell variable the child
// process never sees — and EVERY other line is a `#` comment. The command line is commented too, and
// that is not timidity: `--label=<name>` is a shell redirection, and `[--expires-in=<seconds>]` ends in
// a `>` that would create a file called `]` in whatever directory the operator pasted into.
//
// HARD RULE: no function here takes a key. The block is composed from an ORIGIN and variable NAMES,
// so a caller that is holding the real values (both verbs are) cannot leak one through it.

/** What the calling verb knows about this installation. Both fields are omitted when it would guess. */
export interface MachineKeyNextStep {
	/** IAM's PUBLIC origin — the address `FABRIKA_IAM_RPC_URL` takes. */
	readonly iamOrigin?: string
	/** The sidecar GitHub Environment that also holds the provisioning key, when its name is known. */
	readonly sidecarEnvironment?: string
}

/** The boxed hand-off's title. Exported so a test names it once. */
export const MACHINE_KEY_NEXT_STEP_TITLE = 'NEXT — mint a machine key for `fabrika control`'

/** The command the block leads to, with the two flags `key issue` requires. */
export const MACHINE_KEY_ISSUE_COMMAND = 'fabrika control key issue --label=<name> --permissions=<a,b,c> [--expires-in=<seconds>]'

const WIDEST_NAME = 'FABRIKA_IAM_PROVISIONING_KEY'.length + 1

/** A variable an operator must SUPPLY: a comment, never an assignment, so pasting the block is safe. */
const readFrom = (variable: string, where: string): string => `# ${variable.padEnd(WIDEST_NAME)}read from: ${where}`

/** A continuation of the line above, indented under its `read from:` column. */
const continued = (rest: string): string => `# ${' '.repeat(WIDEST_NAME + 'read from: '.length)}${rest}`

/**
 * The lines of the block, in the order an operator uses them.
 *
 * The origin is the one VALUE printed, because it is not a credential: it is where the installation
 * answers, and the rebuild that motivated this block failed precisely because an operator guessed it.
 * The two keys are named and located; a value for either would come from the environment anyway.
 */
export const machineKeyNextStepLines = (step: MachineKeyNextStep = {}): readonly string[] => [
	step.iamOrigin === undefined
		// Never a guessed origin: the control service records the real one, and reading it is one command.
		? readFrom('FABRIKA_IAM_RPC_URL', "`control`'s own FABRIKA_IAM_ISSUER, in the Zerops project")
		: `export FABRIKA_IAM_RPC_URL=${step.iamOrigin}`,
	readFrom('FABRIKA_IAM_RPC_KEY', "the `iam` or `control` service's env, in the Zerops project"),
	readFrom('FABRIKA_IAM_PROVISIONING_KEY', 'the same env — the copy anyone with the project can read;'),
	continued(
		step.sidecarEnvironment === undefined
			? "the sidecar repository's Environment holds the copy the pipeline uses"
			: `the sidecar's \`${step.sidecarEnvironment}\` Environment holds the copy the pipeline uses`,
	),
	'# then, with the label and the permissions filled in:',
	`#   ${MACHINE_KEY_ISSUE_COMMAND}`,
	'# Both keys are environment-only and have no flag; this block prints NAMES, never values.',
	'# A private hostname such as http://iam:3000 answers only inside the project — use the origin above.',
]
