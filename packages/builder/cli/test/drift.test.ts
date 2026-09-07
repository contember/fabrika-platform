import { afterEach, expect, test } from 'bun:test'
import { derivePhaseState } from '../../daemon/src/phases'
import { derivePhase } from '../src/derive'
import { type Fixture, makeFixture } from './helpers'

let fx: Fixture | null = null
afterEach(() => fx?.cleanup())

const SNAPSHOTS: Record<string, string[]> = {
	empty: [],
	'after-intake': ['.fabrika/intent/brief.md'],
	'after-vision': [
		'.fabrika/intent/brief.md',
		'.fabrika/intent/glossary.md',
		'.fabrika/principles/principles.md',
	],
	'after-flows': [
		'.fabrika/intent/brief.md',
		'.fabrika/intent/glossary.md',
		'.fabrika/principles/principles.md',
		'.fabrika/architecture/flows/login.flow.md',
	],
	'after-design': [
		'.fabrika/intent/brief.md',
		'.fabrika/intent/glossary.md',
		'.fabrika/principles/principles.md',
		'.fabrika/architecture/flows/login.flow.md',
		'.fabrika/architecture/tech.md',
		'.fabrika/architecture/design.md',
		'.fabrika/pages/home.jsx',
	],
	'all-produced': [
		'.fabrika/intent/brief.md',
		'.fabrika/intent/glossary.md',
		'.fabrika/principles/principles.md',
		'.fabrika/architecture/flows/login.flow.md',
		'.fabrika/architecture/tech.md',
		'.fabrika/architecture/design.md',
		'.fabrika/pages/home.jsx',
		'tests/browser/login.test.ts',
		'.fabrika/issues/ISSUE-001.md',
	],
}

test(
	'CLI offline derive agrees with daemon derivePhaseState (no oracle) on every snapshot',
	async () => {
		for (const [name, files] of Object.entries(SNAPSHOTS)) {
			fx = makeFixture()
			for (const f of files) fx.write(f)

			const cli = derivePhase(fx.root) // permissive offline probe
			const daemon = derivePhaseState(fx.fabrikaDir) // no oracle -> gate permissive

			expect(cli.current, `current mismatch on snapshot "${name}"`).toBe(daemon.current)
			expect(cli.completed, `completed mismatch on snapshot "${name}"`).toEqual(daemon.completed)
			expect(cli.gate, `gate mismatch on snapshot "${name}"`).toBe(daemon.gate)
			expect(cli.satisfied, `satisfied mismatch on snapshot "${name}"`).toBe(daemon.satisfied)

			fx.cleanup()
			fx = null
		}
	},
)
