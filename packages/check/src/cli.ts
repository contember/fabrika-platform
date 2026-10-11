#!/usr/bin/env bun

import { resolve } from 'node:path'
import { checkApplication } from './check'
import { type Finding, formatFinding } from './finding'

const USAGE = `fabrika-check — the application checker

Usage:
  fabrika-check [<root>]

Checks the application in <root> (default: the current directory) and prints one line per finding:
  <file>:<line>:<column> <rule> <message> (allowed form: <what to write instead>)

A refusal fails the check. A hint, printed under its own heading after the refusals, reports a step out of the
application architecture and does not fail it.

Exit status: 0 with no refusals, 1 with a refusal, 2 on a usage or read error.
There is no suppression syntax; a finding is fixed in the code.
`

const HINTS_HEADING = 'Hints — the application architecture; they do not fail the check:'

const count = (amount: number, noun: string): string => `${amount} ${noun}${amount === 1 ? '' : 's'}`

const main = async (argv: readonly string[]): Promise<number> => {
	if (argv.includes('--help') || argv.includes('-h')) {
		console.log(USAGE)
		return 0
	}
	const unknownFlag = argv.find((arg) => arg.startsWith('-'))
	if (unknownFlag !== undefined || argv.length > 1) {
		console.error(`fabrika-check: unexpected argument '${unknownFlag ?? argv[1]}'\n\n${USAGE}`)
		return 2
	}
	const root = resolve(argv[0] ?? '.')
	let findings: Finding[]
	try {
		findings = await checkApplication({ root })
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
