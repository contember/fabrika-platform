import type { AstNode, Position } from './ast'
import { positionOf } from './ast'

export const RULE_IDS = [
	'parse-error',
	'literal',
	'contract',
	'forbidden-import',
	'test-only-import',
	'unchecked-import',
	'forbidden-global',
	'raw-sql',
	'type-assertion',
	'any-type',
	'suppression-comment',
	'capability-widening',
	'prototype-assignment',
	'env-read',
	'public-env',
	'cross-app-fetch',
	'key-literal',
	'client-identity',
	'sensitive-log',
	'unsafe-html',
	'dynamic-code',
	'migration-name',
	'crontab',
	'package-replacement',
	'skipped-test',
	'test-without-assertion',
	'generated-test-hash',
] as const

export type RuleId = (typeof RULE_IDS)[number]

export interface Finding {
	/** Relative to the application root, with `/` separators. */
	readonly file: string
	readonly line: number
	readonly column: number
	readonly rule: RuleId
	readonly message: string
	/** What to write instead; every finding names it, because the reader is often an agent with no other feedback. */
	readonly allowed: string
}

export type Report = (at: AstNode | Position, rule: RuleId, message: string, allowed: string) => void

export const reporter = (file: string, findings: Finding[]): Report => (at, rule, message, allowed) => {
	const { line, column } = 'type' in at ? positionOf(at) : at
	findings.push({ file, line, column, rule, message, allowed })
}

export const formatFinding = (finding: Finding): string =>
	`${finding.file}:${finding.line}:${finding.column} ${finding.rule} ${finding.message} (allowed form: ${finding.allowed})`

export const compareFindings = (left: Finding, right: Finding): number =>
	left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column || left.rule.localeCompare(right.rule)
