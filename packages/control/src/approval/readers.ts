// The contract readers of this platform's window (ADR-0062). An application is read by the reader of the framework
// release its `bun.lock` pins: this release's own reader for its own minor, and for every older minor of the window
// the newest patch of `@fabrika/check`, bundled as an exact npm alias, so Control fetches no code at run time.

import * as reader04 from '@fabrika/check-0.4/contract'
import * as reader05 from '@fabrika/check-0.5/contract'
import * as reader06 from '@fabrika/check-0.6/contract'
import * as reader07 from '@fabrika/check-0.7/contract'
import * as reader08 from '@fabrika/check-0.8/contract'
import { CHECKER_VERSION, ContractError, contractReaderInputs, ContractSourceError, readContractSource } from '@fabrika/check/contract'
import { from04, from06, from07, from08, fromOlder, type SnapshotContract } from './formats'

/** The package whose locked version is the application's framework release: every contract imports it. */
export const FRAMEWORK_PACKAGE = '@fabrika/app'

/** Where an application finds what changed between two framework releases. */
export const MIGRATION_GUIDE = 'https://github.com/contember/fabrika-platform/blob/main/docs/reference/framework-migrations.md'

/** A release as npm publishes it. Only these characters ever reach a run log or a generated build command. */
const RELEASE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/

export type ReaderOutcome =
	| { readonly ok: true; readonly contract: SnapshotContract }
	/** The reader refused the contract; only the number of problems leaves it, never the checkout's text. */
	| { readonly ok: false; readonly problems: number }

/** One release's static reader. Any error it throws besides a refusal is unexpected and may quote the checkout. */
export interface ContractReader {
	/** The `@fabrika/check` release of the reader, which a snapshot records as its `checker`. */
	readonly checker: string
	/** The paths the reader needs that `files` does not hold yet (`contractReaderInputs` of its release). */
	inputs(files: ReadonlyMap<string, string>, exists: (path: string) => boolean): string[]
	read(files: ReadonlyMap<string, string>): ReaderOutcome
}

const currentReader: ContractReader = {
	checker: CHECKER_VERSION,
	inputs: contractReaderInputs,
	read(files) {
		try {
			return { ok: true, contract: { contract: readContractSource(files) } }
		} catch (error) {
			if (error instanceof ContractSourceError) return { ok: false, problems: error.findings.length }
			if (error instanceof ContractError) return { ok: false, problems: error.problems.length }
			throw error
		}
	},
}

const reader08Release: ContractReader = {
	checker: reader08.CHECKER_VERSION,
	inputs: reader08.contractReaderInputs,
	read(files) {
		try {
			return { ok: true, contract: from08(reader08.readContractSource(files)) }
		} catch (error) {
			if (error instanceof reader08.ContractSourceError) return { ok: false, problems: error.findings.length }
			if (error instanceof reader08.ContractError) return { ok: false, problems: error.problems.length }
			throw error
		}
	},
}

const reader07Release: ContractReader = {
	checker: reader07.CHECKER_VERSION,
	inputs: reader07.contractReaderInputs,
	read(files) {
		try {
			return { ok: true, contract: from07(reader07.readContractSource(files)) }
		} catch (error) {
			if (error instanceof reader07.ContractSourceError) return { ok: false, problems: error.findings.length }
			if (error instanceof reader07.ContractError) return { ok: false, problems: error.problems.length }
			throw error
		}
	},
}

const reader06Release: ContractReader = {
	checker: reader06.CHECKER_VERSION,
	inputs: reader06.contractReaderInputs,
	read(files) {
		try {
			return { ok: true, contract: from06(reader06.readContractSource(files)) }
		} catch (error) {
			if (error instanceof reader06.ContractSourceError) return { ok: false, problems: error.findings.length }
			if (error instanceof reader06.ContractError) return { ok: false, problems: error.problems.length }
			throw error
		}
	},
}

const reader05Release: ContractReader = {
	checker: reader05.CHECKER_VERSION,
	inputs: reader05.contractReaderInputs,
	read(files) {
		try {
			return { ok: true, contract: fromOlder(reader05.readContractSource(files)) }
		} catch (error) {
			if (error instanceof reader05.ContractSourceError) return { ok: false, problems: error.findings.length }
			if (error instanceof reader05.ContractError) return { ok: false, problems: error.problems.length }
			throw error
		}
	},
}

const reader04Release: ContractReader = {
	checker: reader04.CHECKER_VERSION,
	inputs: reader04.contractReaderInputs,
	read(files) {
		try {
			return { ok: true, contract: from04(reader04.readContractSource(files)) }
		} catch (error) {
			if (error instanceof reader04.ContractSourceError) return { ok: false, problems: error.findings.length }
			if (error instanceof reader04.ContractError) return { ok: false, problems: error.problems.length }
			throw error
		}
	},
}

export interface Release {
	readonly text: string
	readonly major: number
	readonly minor: number
	readonly patch: number
}

export function parseRelease(text: string): Release | null {
	const match = RELEASE.exec(text)
	if (match === null) return null
	return { text, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function requireRelease(text: string): Release {
	const release = parseRelease(text)
	if (release === null) throw new Error(`\`${text}\` is not a release version`)
	return release
}

const minorOf = (release: Release): string => `${release.major}.${release.minor}`

export const compareReleases = (a: Release, b: Release): number => a.major - b.major || a.minor - b.minor || a.patch - b.patch

/** A framework window: the platform's own release and the reader of each minor it deploys. */
export interface ReaderWindow {
	readonly platform: string
	readonly readers: readonly ContractReader[]
}

/** This platform's window: its own minor and every older one it bundles a reader for. */
export const PLATFORM_WINDOW: ReaderWindow = {
	platform: CHECKER_VERSION,
	readers: [currentReader, reader08Release, reader07Release, reader06Release, reader05Release, reader04Release],
}

/** The application pins a framework release this platform does not deploy, or pins none it can read. One line. */
export class FrameworkReleaseRefused extends Error {
	override readonly name = 'FrameworkReleaseRefused'
}

/**
 * The reader of the window for the framework release `pinned`: the one of its minor. A release older than every minor
 * of the window is refused with the oldest one it deploys and the migration guide; a release newer than the platform
 * is refused, because the platform is upgraded first.
 */
export function readerFor(pinned: string, window: ReaderWindow = PLATFORM_WINDOW): ContractReader {
	const release = parseRelease(pinned)
	if (release === null) throw new FrameworkReleaseRefused(`bun.lock resolves ${FRAMEWORK_PACKAGE} to no release version`)
	const platform = requireRelease(window.platform)
	if (compareReleases(release, platform) > 0) {
		throw new FrameworkReleaseRefused(
			`the application pins ${FRAMEWORK_PACKAGE} ${release.text}, newer than this platform's ${platform.text}; upgrade the platform first`,
		)
	}
	const byMinor = new Map(window.readers.map((reader) => [minorOf(requireRelease(reader.checker)), reader]))
	const reader = byMinor.get(minorOf(release))
	if (reader !== undefined) return reader
	const oldest = window.readers.map((candidate) => requireRelease(candidate.checker)).sort(compareReleases)[0]
	const oldestText = oldest === undefined ? platform.text : `${minorOf(oldest)}.0`
	throw new FrameworkReleaseRefused(
		`the application pins ${FRAMEWORK_PACKAGE} ${release.text}, outside this platform's window; the oldest release it deploys is ${oldestText}. Raise the pin as ${MIGRATION_GUIDE} describes`,
	)
}
