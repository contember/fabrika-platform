import { afterEach, expect, test } from 'bun:test'
import { derivePhase } from '../src/derive'
import { packetJson, renderPacket } from '../src/packet'
import { PHASE_COUNT } from '../src/phases'
import { type Fixture, makeFixture } from './helpers'

let fx: Fixture | null = null
afterEach(() => fx?.cleanup())

test('packet for intake has the expected sections', () => {
	fx = makeFixture()
	const packet = renderPacket(derivePhase(fx.root))

	expect(packet).toContain(`## Phase 1/${PHASE_COUNT} - Intake`)
	expect(packet).toContain('Read:')
	expect(packet).toContain('Goal:')
	expect(packet).toContain('Skills:')
	expect(packet).toContain('Gate:')
	expect(packet).toContain('After OK:')
	expect(packet).toContain('fabrika builder gate open intake --view brief.jsx && fabrika builder gate wait')
	expect(packet).toContain('fabrika builder advance && fabrika builder next')
})

test('packet header shows completed phases with a checkmark', () => {
	fx = makeFixture()
	fx.write('.fabrika/intent/brief.md')
	const packet = renderPacket(derivePhase(fx.root))
	expect(packet).toContain(`## Phase 2/${PHASE_COUNT} - Vision`)
	expect(packet).toContain('(intake ✓)')
})

test('ungated phase (issues) emits a no-gate line', () => {
	fx = makeFixture()
	fx.write('.fabrika/intent/brief.md')
	fx.write('.fabrika/intent/glossary.md')
	fx.write('.fabrika/principles/principles.md')
	fx.write('.fabrika/architecture/flows/login.flow.md')
	fx.write('.fabrika/architecture/tech.md')
	fx.write('.fabrika/architecture/design.md')
	fx.write('.fabrika/pages/home.jsx')
	fx.write('tests/browser/login.test.ts')
	const packet = renderPacket(derivePhase(fx.root))
	expect(packet).toContain(`## Phase 7/${PHASE_COUNT}`)
	expect(packet).toContain('Gate:    (none')
})

test('packetJson mirrors the structured fields', () => {
	fx = makeFixture()
	fx.write('.fabrika/intent/brief.md')
	const json = packetJson(derivePhase(fx.root))
	expect(json.phase).toBe('vision')
	expect(json.index).toBe(1)
	expect(json.number).toBe(2)
	expect(json.gate).toBe(true)
	expect(json.gateView).toBe('vision.jsx')
	expect(json.completed).toEqual(['intake'])
	expect(json.produces).toContain('.fabrika/principles/principles.md')
})

function landOnTech(fx: Fixture): void {
	fx.write('.fabrika/intent/brief.md')
	fx.write('.fabrika/intent/glossary.md')
	fx.write('.fabrika/principles/principles.md')
	fx.write('.fabrika/architecture/flows/login.flow.md')
}

test('tech packet emits an absolute Stack: pointer when a profile is given', () => {
	fx = makeFixture()
	landOnTech(fx)
	const packet = renderPacket(derivePhase(fx.root), { profile: 'cf-lightweight' })
	expect(packet).toContain(`## Phase 4/${PHASE_COUNT} - Tech`)
	expect(packet).toContain('Stack:   cf-lightweight ->')
	expect(packet).toContain('/stacks/cf-lightweight.md')
	expect(packet).toContain('/decisions/')
})

test('tech packet omits the Stack: pointer when no profile is supplied', () => {
	fx = makeFixture()
	landOnTech(fx)
	const packet = renderPacket(derivePhase(fx.root))
	expect(packet).toContain(`## Phase 4/${PHASE_COUNT} - Tech`)
	expect(packet).not.toContain('/stacks/cf-lightweight.md')
})

test('a non-catalog phase has no Stack: pointer even with a profile', () => {
	fx = makeFixture()
	const packet = renderPacket(derivePhase(fx.root), { profile: 'cf-lightweight' })
	expect(packet).toContain(`## Phase 1/${PHASE_COUNT} - Intake`)
	expect(packet).not.toContain('/stacks/cf-lightweight.md')
})

test('packetJson carries the resolved stack pointer for the tech phase only', () => {
	fx = makeFixture()
	landOnTech(fx)
	const techJson = packetJson(derivePhase(fx.root), { profile: 'cf-lightweight' })
	expect(techJson.phase).toBe('tech')
	expect(techJson.stack).not.toBeNull()
	expect(techJson.stack!.stackFileExists).toBe(true)

	fx.cleanup()
	fx = makeFixture()
	const intakeJson = packetJson(derivePhase(fx.root), { profile: 'cf-lightweight' })
	expect(intakeJson.phase).toBe('intake')
	expect(intakeJson.stack).toBeNull()
})

test('build phase packet uses the build After-OK line', () => {
	fx = makeFixture()
	fx.write('.fabrika/intent/brief.md')
	fx.write('.fabrika/intent/glossary.md')
	fx.write('.fabrika/principles/principles.md')
	fx.write('.fabrika/architecture/flows/login.flow.md')
	fx.write('.fabrika/architecture/tech.md')
	fx.write('.fabrika/architecture/design.md')
	fx.write('.fabrika/pages/home.jsx')
	fx.write('tests/browser/login.test.ts')
	fx.write('.fabrika/issues/ISSUE-001.md')
	const packet = renderPacket(derivePhase(fx.root))
	expect(packet).toContain(`## Phase 8/${PHASE_COUNT} - Build`)
	expect(packet).toContain('fabrika builder build')
})
