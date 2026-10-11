/** Every reason a contract does not compile, each with where it is and the allowed form. */
export class ContractError extends Error {
	override readonly name = 'ContractError'
	readonly problems: readonly string[]

	constructor(problems: readonly string[]) {
		super(`the contract does not compile:\n- ${problems.join('\n- ')}`)
		this.problems = problems
	}
}

/** Collects problems so that one compile reports all of them, not the first. */
export class Problems {
	readonly #problems: string[] = []

	add(where: string, problem: string): void {
		this.#problems.push(`${where}: ${problem}`)
	}

	throwIfAny(): void {
		if (this.#problems.length > 0) {
			throw new ContractError([...this.#problems])
		}
	}
}

/** A builder of the staged kit whose signature is fixed and whose runtime a later work unit of the sprint adds. */
export function notImplemented(what: string, unit: string): never {
	throw new Error(`${what} is not implemented (${unit})`)
}
