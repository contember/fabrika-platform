#!/usr/bin/env bun

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { checkApplication } from './check'
import { type Finding, formatFinding } from './finding'
import { type PackedSet, readPackedSet } from './packed'

const USAGE = `fabrika-check — the application checker

Usage:
  fabrika-check [--packed <release-manifest.json>] [<root>]

Checks the application in <root> (default: the current directory) and prints one line per finding:
  <file>:<line>:<column> <rule> <message> (allowed form: <what to write instead>)

--packed accepts the tarballs of a local pack (bun scripts/release.ts pack --local) in place of registry versions:
file: specifiers and overrides of its @fabrika/* packages, and their lockfile entries, when each tarball's bytes
match the sha512 the manifest records. Only a local or dogfood setup passes it; the platform build never does.

A refusal fails the check. A hint, printed under its own heading after the refusals, reports a step out of the
application architecture and does not fail it.

Exit status: 0 with no refusals, 1 with a refusal, 2 on a usage or read error.
There is no suppression syntax; a finding is fixed in the code.
`

const HINTS_HEADING = 'Hints — the application architecture; they do not fail the check:'

const count = (amount: number, noun: string): string => `${amount} ${noun}${amount === 1 ? '' : 's'}`

interface Arguments {
	readonly root: string | undefined
	readonly packed: string | undefined
}

/** The root and the `--packed` manifest, or the first argument the checker does not take. */
const parseArguments = (argv: readonly string[]): Arguments | { readonly unexpected: string } => {
	let root: string | undefined
	let packed: string | undefined
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index] ?? ''
		if (argument === '--packed' && packed === undefined && argv[index + 1] !== undefined) packed = argv[++index]
		else if (argument.startsWith('--packed=') && packed === undefined) packed = argument.slice('--packed='.length)
		else if (argument.startsWith('-') || root !== undefined) return { unexpected: argument }
		else root = argument
	}
	return { root, packed }
}

const main = async (argv: readonly string[]): Promise<number> => {
	if (argv.includes('--help') || argv.includes('-h')) {
		console.log(USAGE)
		return 0
	}
	const parsed = parseArguments(argv)
	if ('unexpected' in parsed) {
		console.error(`fabrika-check: unexpected argument '${parsed.unexpected}'\n\n${USAGE}`)
		return 2
	}
	const root = resolve(parsed.root ?? '.')
	let packed: PackedSet | undefined
	if (parsed.packed !== undefined) {
		try {
			packed = await readPackedSet(root, await readFile(resolve(parsed.packed), 'utf8'))
		} catch (error) {
			console.error(`fabrika-check: cannot read the packed set ${parsed.packed}: ${error instanceof Error ? error.message : 'unknown error'}`)
			return 2
		}
		console.error(`fabrika-check: accepting the tarballs of the local pack ${packed.version}, which no deploy build does`)
	}
	let findings: Finding[]
	try {
		findings = await checkApplication({ root, packed })
	} catch (error) {
		console.error(`fabrika-check: cannot read ${root}: ${error instanceof Error ? error.message : 'unknown error'}`)
		return 2
	}
	const refusals = findings.filter((finding) => finding.severity === 'refusal')
	const hints = findings.filter((finding) => finding.severity === 'hint')
	for (const finding of refusals) console.log(formatFinding(finding))
	if (hints.length > 0) console.log(HINTS_HEADING)
	for (const finding of hints) console.log(formatFinding(finding))
	console.error(`fabrika-check: ${count(refusals.length, 'refusal')}, ${count(hints.length, 'hint')}`)
	return refusals.length === 0 ? 0 : 1
}

process.exitCode = await main(process.argv.slice(2))
