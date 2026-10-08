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
