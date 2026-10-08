// The CLI surface of `fabrika platform upgrade --provider=zerops`, parsed once.
//
// The same shape the other verbs use: an unknown flag is an error rather than a value silently
// ignored, and every message names what would have supplied the missing input. This command holds no
// credential of its own — it drives `git` and `gh`, which carry the operator's own login — so unlike
// `deploy` there is nothing here that must be kept off the command line.
//
// The pin is checked BEFORE anything leaves this machine: `assertPinnedTag` refuses a branch or a SHA
// (ADR-0025) without a network call, so `--to=main` fails on the spot rather than after a clone.

import { assertPinnedTag, defaultCheckoutDir } from './sidecar'

/** Where the sidecar repository this command edits is found. */
export type UpgradeSidecar =
	/** An existing local checkout — the one `platform init` left behind, or any other clone. */
	| { readonly kind: 'checkout'; readonly dir: string }
	/** `<owner>/<name>`, cloned into a temporary directory for the length of the run. */
	| { readonly kind: 'repo'; readonly repo: string }

/** Every input `runUpgrade` takes from the operator. */
export interface PlatformUpgradeInput {
	/** The published fabrika tag to roll onto, already checked to be one. */
	readonly to: string
	readonly sidecar: UpgradeSidecar
	/** The operator's name for this installation, when they gave one. Only ever used in the commit subject. */
	readonly installation?: string
	/** Read everything, write nothing, push nothing. */
	readonly dryRun: boolean
}

const FLAGS = ['--to', '--sidecar'] as const

/** The one value-less flag. */
export const UPGRADE_DRY_RUN_FLAG = '--dry-run'

/**
 * `<owner>/<name>`, and nothing that could also be a directory.
 *
 * `--sidecar` takes either form, so the two need a rule an operator can predict rather than a
 * filesystem probe whose answer depends on what happens to exist. A value with exactly one slash and
 * no leading `.`, `~` or `/` is a REPOSITORY; anything else is a path, which makes `./owner/name` the
 * way to name a local directory shaped like a repository.
 */
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

const readFlag = (argv: readonly string[], name: string): string | undefined => {
	const prefix = `${name}=`
	const matches = argv.filter((arg) => arg.startsWith(prefix))
	if (matches.length > 1) {
		throw new Error(`${name} was given more than once`)
	}
	const value = matches[0]?.slice(prefix.length)
	return value === undefined || value.trim() === '' ? undefined : value.trim()
}

const assertKnownArguments = (argv: readonly string[]): void => {
	for (const arg of argv) {
		if (arg === UPGRADE_DRY_RUN_FLAG || !arg.startsWith('-')) {
			continue
		}
		const name = arg.split('=')[0] ?? arg
		if (!FLAGS.some((flag) => flag === name) || !arg.includes('=')) {
			throw new Error(
				`unexpected argument \`${arg}\`. Run \`fabrika platform upgrade --provider=zerops --help\` for the surface`,
			)
		}
	}
}

/** The single positional: the installation name, exactly as `platform init` takes it. */
const readInstallation = (argv: readonly string[]): string | undefined => {
	const positional = argv.filter((arg) => !arg.startsWith('-'))
	if (positional.length > 1) {
		throw new Error(`unexpected argument \`${positional[1]}\`: name ONE installation`)
	}
	const installation = positional[0]?.trim()
	return installation === undefined || installation === '' ? undefined : installation
}

const readSidecar = (argv: readonly string[], installation: string | undefined): UpgradeSidecar => {
	const named = readFlag(argv, '--sidecar')
	if (named !== undefined) {
		return REPO_PATTERN.test(named) ? { kind: 'repo', repo: named } : { kind: 'checkout', dir: named }
	}
	if (installation === undefined) {
		throw new Error(
			'name the installation (`fabrika platform upgrade --provider=zerops --to=<tag> <installation>`) or its sidecar '
				+ 'with --sidecar=<path>|<owner>/<name>',
		)
	}
	return { kind: 'checkout', dir: defaultCheckoutDir(installation) }
}

/** Parse the command's arguments into the one input `runUpgrade` takes. */
export const parsePlatformUpgradeArgs = (argv: readonly string[]): PlatformUpgradeInput => {
	assertKnownArguments(argv)
	const to = readFlag(argv, '--to')
	if (to === undefined) {
		throw new Error('--to=<tag> is required — the published fabrika release to roll onto, for example --to=v0.1.0')
	}
	const installation = readInstallation(argv)
	return {
		to: assertPinnedTag(to),
		sidecar: readSidecar(argv, installation),
		dryRun: argv.includes(UPGRADE_DRY_RUN_FLAG),
		...(installation === undefined ? {} : { installation }),
	}
}
