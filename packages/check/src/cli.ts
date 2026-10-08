#!/usr/bin/env bun

import { resolve } from 'node:path'
import { checkApplication } from './check'
import { type Finding, formatFinding } from './finding'

const USAGE = `fabrika-check — the application checker

Usage:
  fabrika-check [<root>]

Checks the application in <root> (default: the current directory) and prints one line per finding:
  <file>:<line>:<column> <rule> <message> (allowed form: <what to write instead>)

Exit status: 0 with no findings, 1 with findings, 2 on a usage or read error.
There is no suppression syntax; a finding is fixed in the code.
`

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
	for (const finding of findings) console.log(formatFinding(finding))
	console.error(`fabrika-check: ${findings.length} finding${findings.length === 1 ? '' : 's'}`)
	return findings.length === 0 ? 0 : 1
}

process.exitCode = await main(process.argv.slice(2))
