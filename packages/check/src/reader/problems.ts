import { type Finding, reporter } from '../finding'
import type { Located } from '../graph'

/** Every form the reader refuses, as findings of the `contract` rule with where it is and the allowed form. */
export class ReaderProblems {
	readonly findings: Finding[] = []

	add(at: Located, message: string, allowed: string): void {
		reporter(at.module.file, this.findings)(at.node, 'contract', message, allowed)
	}
}
