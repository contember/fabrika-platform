import type { AstNode, Position } from './ast'
import { positionOf } from './ast'

/** Rules whose finding fails the check: the framework's forms and platform integrity. */
export const REFUSAL_RULE_IDS = [
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
	'framework-write',
	'env-read',
	'public-env',
	'cross-app-fetch',
	'url-endpoint',
	'on-conflict-index',
	'key-literal',
	'client-identity',
	'sensitive-log',
	'unsafe-html',
	'dynamic-code',
	'migration-name',
	'migration-refused',
	'backup-schema',
	'migration-edited',
	'file-column-migration',
	'crontab',
	'package-replacement',
	'skipped-test',
	'test-without-assertion',
	'generated-test-hash',
	'mock-module',
	'endpoint-fixture',
	'spa-server-import',
	'layer-import',
	'generated-test-import',
	'shared-import',
	'cloudflare-scan',
	'cloudflare-job-segment',
	'cloudflare-current-timestamp',
	'cloudflare-framework-name',
] as const

/** Rules that report a step out of the application architecture. */
export const STRUCTURE_HINT_RULE_IDS = ['logic-data-access', 'cross-slice-queries', 'handler-location', 'data-access-location'] as const

/**
 * Rules whose findings never fail the check: the architecture's, a `ctx.sql` its site does not declare, a
 * `{ member: true }` endpoint of a contract whose external role admits people from outside the organization, and a
 * Cloudflare mutation that waits for an outside call inside the object's transaction.
 */
export const HINT_RULE_IDS = [...STRUCTURE_HINT_RULE_IDS, 'sql-undeclared', 'member-admits-external', 'cloudflare-held-call'] as const

export const RULE_IDS = [...REFUSAL_RULE_IDS, ...HINT_RULE_IDS] as const

export type RefusalRuleId = (typeof REFUSAL_RULE_IDS)[number]
export type HintRuleId = (typeof HINT_RULE_IDS)[number]
export type RuleId = (typeof RULE_IDS)[number]
export type Severity = 'refusal' | 'hint'

interface FindingFields {
	/** Relative to the application root, with `/` separators. */
	readonly file: string
	readonly line: number
	readonly column: number
	readonly message: string
	/** What to write instead; every finding names it, because the reader is often an agent with no other feedback. */
	readonly allowed: string
}

/** A finding's severity is its rule's: a refusal rule never reports a hint, nor the reverse. */
export type Finding =
	| (FindingFields & { readonly severity: 'refusal'; readonly rule: RefusalRuleId })
	| (FindingFields & { readonly severity: 'hint'; readonly rule: HintRuleId })

export const isHintRule = (rule: RuleId): rule is HintRuleId => HINT_RULE_IDS.some((hint) => hint === rule)

export type Report = (at: AstNode | Position, rule: RuleId, message: string, allowed: string) => void

export const reporter = (file: string, findings: Finding[]): Report => (at, rule, message, allowed) => {
	const { line, column } = 'type' in at ? positionOf(at) : at
	if (isHintRule(rule)) findings.push({ file, line, column, severity: 'hint', rule, message, allowed })
	else findings.push({ file, line, column, severity: 'refusal', rule, message, allowed })
}

export const formatFinding = (finding: Finding): string =>
	`${finding.file}:${finding.line}:${finding.column} ${finding.rule} ${finding.message} (allowed form: ${finding.allowed})`

export const compareFindings = (left: Finding, right: Finding): number =>
	left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column || left.rule.localeCompare(right.rule)
