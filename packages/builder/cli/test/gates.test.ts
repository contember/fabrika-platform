import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { GATE_APPROVE, GATE_CHANGES, GATE_VERDICT_ID, gateVerdict } from '../../shared/gate'
import { PHASES } from '../../shared/phases'

const GATES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../skill/gates')

test('every gate view ends with the verdict question the daemon reads', () => {
	const verdict = `<Choice id="${GATE_VERDICT_ID}" label="Verdict" required options={['${GATE_APPROVE}', '${GATE_CHANGES}']} />`
	const views = readdirSync(GATES_DIR).filter((name) => name.endsWith('.jsx'))
	for (const phase of PHASES.filter((p) => p.gate && !p.gateViewCommand)) expect(views).toContain(phase.gateView ?? `${phase.id}.jsx`)
	for (const view of views) {
		const source = readFileSync(join(GATES_DIR, view), 'utf-8')
		expect(source, view).toContain(verdict)
		expect(source.trimEnd().endsWith(`${verdict}\n</Section>`), view).toBe(true)
	}
})

test('the verdict is read from the answers, never guessed', () => {
	expect(gateVerdict([{ id: GATE_VERDICT_ID, value: GATE_APPROVE }])).toBe('approve')
	expect(gateVerdict([{ id: GATE_VERDICT_ID, value: GATE_CHANGES }])).toBe('changes')
	expect(gateVerdict([{ id: GATE_VERDICT_ID, value: 'Yes, proceed' }])).toBe('none')
	expect(gateVerdict([{ id: 'other', value: GATE_APPROVE }])).toBe('none')
	expect(gateVerdict([])).toBe('none')
})
