import type { AppGates, GateRule } from './types'

/** A gate rule with its path glob precompiled. */
export interface CompiledGate {
	readonly rule: GateRule
	matches(pathname: string): boolean
}

/** Precompile an app's gate rules while preserving declaration order. */
export function compileGates(gates: AppGates): CompiledGate[] {
	return gates.rules.map((rule) => {
		const regex = globToRegExp(rule.path)
		return { rule, matches: (pathname: string) => regex.test(pathname) }
	})
}

/** Return matching rules in declaration order. */
export function applicableGates(compiled: readonly CompiledGate[], pathname: string): CompiledGate[] {
	return compiled.filter((gate) => gate.matches(pathname))
}

/** Glob where `*` crosses path separators; all other characters are literal. */
function globToRegExp(pattern: string): RegExp {
	return new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`)
}

function escapeRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
