// The seed module of `fabrika app dev`: its default export runs once against the kit before the first request, and
// what it answers is parsed here, at the boundary, into the personas, link pages and scope values the picker offers.

import type { AnyContract } from '@fabrika/app/contract'
import type { DevKit, PersonTestCaller } from '@fabrika/app/testing'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod/v4'

/** The seed `app dev` runs when `--seed` names none and the file exists. */
export const DEFAULT_SEED = 'dev/seed.ts'

const MAX_ENTRIES = 50
const MAX_NAME = 80
const MAX_DESCRIPTION = 240
const MAX_SCOPE_VALUE = 200

export interface SeedPersona {
	readonly name: string
	readonly description: string | null
	readonly caller: PersonTestCaller
}

export interface SeedLink {
	readonly title: string
	readonly description: string | null
	readonly url: string
}

/** What the seed answered, validated: unique persona names, the kit's own people, local link paths, known dimensions. */
export interface Seeded {
	readonly personas: readonly SeedPersona[]
	readonly links: readonly SeedLink[]
	/** The labelled values of each dimension, by dimension. */
	readonly scopes: ReadonlyMap<string, readonly { readonly value: string; readonly label: string }[]>
}

export const NOTHING_SEEDED: Seeded = { personas: [], links: [], scopes: new Map() }

/** A refusal of what the seed answered; it names an entry by its position, never by what the seed wrote. */
export class SeedProblem extends Error {
	override readonly name = 'SeedProblem'
}

const Text = (max: number) => z.string().trim().min(1).max(max)

const SeedResult = z.strictObject({
	personas: z.array(z.strictObject({ name: Text(MAX_NAME), description: Text(MAX_DESCRIPTION).optional(), caller: z.unknown() })).max(MAX_ENTRIES)
		.optional(),
	links: z.array(z.strictObject({ title: Text(MAX_NAME), description: Text(MAX_DESCRIPTION).optional(), url: z.string().max(4096) })).max(MAX_ENTRIES)
		.optional(),
	scopes: z.record(z.string(), z.array(z.strictObject({ value: Text(MAX_SCOPE_VALUE), label: Text(MAX_NAME) })).max(MAX_ENTRIES)).optional(),
}).optional()

/** A path of this origin; a link the application issued is one (`/s/#px_…`). */
export function isLocalPath(path: string): boolean {
	return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\')
}

/** The seed module's path: `--seed`, relative to the root, or `dev/seed.ts` when it exists; `null` for none. */
export function seedPath(root: string, given: string | null): string | null {
	if (given !== null) {
		const path = isAbsolute(given) ? given : join(root, given)
		if (!existsSync(path)) throw new SeedProblem(`app dev: --seed names no file: ${given}`)
		return path
	}
	const conventional = join(root, DEFAULT_SEED)
	return existsSync(conventional) ? conventional : null
}

/** The seed's default export, a function; its import runs application code, so the caller withholds what it throws. */
export async function importSeed(path: string): Promise<(dev: unknown) => unknown> {
	const module: unknown = await import(pathToFileURL(path).href)
	const seed: unknown = typeof module === 'object' && module !== null ? Reflect.get(module, 'default') : undefined
	if (typeof seed !== 'function') {
		throw new SeedProblem('app dev: the seed module default-exports no function: export default (async (dev) => { … }) satisfies DevSeed<…>')
	}
	return (dev) => Reflect.apply(seed, undefined, [dev])
}

/** What `answer`, the seed's result, offers the picker, or a `SeedProblem` naming the entry that is wrong. */
export function parseSeeded<C extends AnyContract>(dev: DevKit<C>, answer: unknown): Seeded {
	const parsed = SeedResult.safeParse(answer)
	if (!parsed.success) {
		const issue = parsed.error.issues[0]
		const where = issue === undefined ? '' : ` at ${issue.path.map(String).join('.')} (${issue.code})`
		throw new SeedProblem(`app dev: the seed answered no { personas, links, scopes }${where}`)
	}
	const result = parsed.data ?? {}
	const names = new Set<string>()
	const personas = (result.personas ?? []).map((persona, index): SeedPersona => {
		const caller = dev.personOf(persona.caller)
		if (caller === undefined) {
			throw new SeedProblem(`app dev: persona ${index + 1} of the seed holds no person of its kit: dev.testCaller(grants, { label, email })`)
		}
		if (caller.cookie === null) {
			throw new SeedProblem(`app dev: persona ${index + 1} of the seed signs in with a key; a browser carries a session (via: 'session')`)
		}
		if (names.has(persona.name)) throw new SeedProblem(`app dev: persona ${index + 1} of the seed repeats the name of an earlier one`)
		names.add(persona.name)
		return { name: persona.name, description: persona.description ?? null, caller }
	})
	const links = (result.links ?? []).map((link, index): SeedLink => {
		if (!isLocalPath(link.url)) {
			throw new SeedProblem(`app dev: link ${index + 1} of the seed is not a path of the application, as ctx.links answers it`)
		}
		return { title: link.title, description: link.description ?? null, url: link.url }
	})
	const dimensions = dev.kit.artifact.dimensions
	const scopes = new Map<string, readonly { readonly value: string; readonly label: string }[]>()
	for (const [dimension, values] of Object.entries(result.scopes ?? {})) {
		if (!Object.hasOwn(dimensions, dimension)) {
			throw new SeedProblem('app dev: the seed names scope values of a dimension the vocabulary does not declare')
		}
		scopes.set(dimension, values)
	}
	return { personas, links, scopes }
}
