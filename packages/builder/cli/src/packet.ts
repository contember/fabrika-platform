import { join } from 'node:path'
import type { BuilderProjectConnection } from '../../shared'
import { PHASE_COUNT, phaseById, type PhaseId, phaseIndex } from '../../shared/phases'
import { resolveStackPointer, type StackPointer } from './catalog'
import type { PhaseState } from './derive'

export interface RenderOpts {
	profile?: string
	connection?: BuilderProjectConnection
}

const CHECK = '✓' // ✓

export function renderPacket(state: PhaseState, opts: RenderOpts = {}): string {
	const phase = phaseById(state.current)
	const lines: string[] = []
	if (opts.connection) lines.push(`Platform: ${JSON.stringify(connectionContext(opts.connection))}`)

	const done = state.completed.map((id) => `${id} ${CHECK}`).join(', ')
	const completedSuffix = done ? `   (${done})` : ''
	lines.push(`## Phase ${phase.number}/${PHASE_COUNT} - ${phase.title}${completedSuffix}`)

	const reads = state.reads.length > 0 ? state.reads.join(', ') : phase.reads.join(', ')
	lines.push(`Read:    ${reads}`)

	if (phase.catalog && opts.profile) {
		lines.push(...stackPointerLines(opts.profile))
	}

	lines.push(`Goal:    ${phase.goal}`)

	if (phase.skills) lines.push(`Skills:  ${phase.skills.join(', ')}`)

	if (phase.gate) {
		const view = phase.gateView ?? `${phase.id}.jsx`
		lines.push(`Gate:    fabrika builder gate open ${phase.id} --view ${view} && fabrika builder gate wait`)
	} else {
		lines.push(`Gate:    (none - deterministic compile step; review optional)`)
	}

	if (phase.id === 'build') {
		lines.push(`After OK: fabrika builder build   (apply agents/build-orchestrator.md in the main session)`)
	} else {
		lines.push(`After OK: fabrika builder advance && fabrika builder next`)
	}

	return lines.join('\n') + '\n'
}

function stackPointerLines(profile: string): string[] {
	const p = resolveStackPointer(profile)
	if (!p) {
		return [`Stack:   ${profile} (decision catalog not found alongside the CLI — see the fabrika repo's stacks/ + decisions/)`]
	}
	if (!p.stackFileExists) {
		return [
			`Stack:   ${profile} — preset NOT found; pick one of ${join(p.root, 'stacks')}/*.md`,
			`         then resolve its \`decisions:\` ids under ${p.decisionsDir}/`,
		]
	}
	return [
		`Stack:   ${profile} -> ${p.stackFile}`,
		`         read it, then resolve its \`decisions:\` ids under ${p.decisionsDir}/ (curated reference + live \`sources\` — verify against current APIs)`,
	]
}

export interface PacketJson {
	phase: PhaseId
	index: number
	number: number
	title: string
	reads: string[]
	produces: string[]
	gate: boolean
	gateView: string | null
	skills: string[]
	completed: PhaseId[]
	satisfied: boolean
	stack: StackPointer | null
	platform: ReturnType<typeof connectionContext> | null
}

export function packetJson(state: PhaseState, opts: RenderOpts = {}): PacketJson {
	const phase = phaseById(state.current)
	return {
		platform: opts.connection ? connectionContext(opts.connection) : null,
		phase: phase.id,
		index: phaseIndex(phase.id),
		number: phase.number,
		title: phase.title,
		reads: state.reads,
		produces: state.produces,
		gate: phase.gate,
		gateView: phase.gateView ?? null,
		skills: phase.skills ?? [],
		completed: state.completed,
		satisfied: state.satisfied,
		stack: phase.catalog && opts.profile ? resolveStackPointer(opts.profile) : null,
	}
}

function connectionContext(connection: BuilderProjectConnection) {
	return {
		controlOrigin: connection.controlOrigin,
		provider: connection.receipt.provider,
		app: connection.receipt.app,
		environment: connection.receipt.environment,
	}
}
