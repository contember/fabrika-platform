import { z } from 'zod/v4'
import { type AstNode, child, children, type ParsedModule, staticKey, stringLiteral, walk } from '../ast'
import type { Finding } from '../finding'

export interface ContractJob {
	readonly name: string
	readonly schedule: string | undefined
}

/** Every `<name>: c.cron('<schedule>', { … })` in the contract. */
export const contractJobs = (contract: ParsedModule): readonly ContractJob[] => {
	const jobs: ContractJob[] = []
	walk(contract.program, (node) => {
		if (node.type !== 'Property') return
		const value = child(node, 'value')
		const callee = value?.type === 'CallExpression' ? child(value, 'callee') : undefined
		if (value === undefined || callee?.type !== 'MemberExpression' || staticKey(callee, 'property') !== 'cron') return
		const name = staticKey(node, 'key')
		const first: AstNode | null | undefined = children(value, 'arguments')[0]
		if (name !== undefined) jobs.push({ name, schedule: stringLiteral(first ?? undefined) })
	})
	return jobs
}

const crontabEntrySchema = z.object({
	timing: z.string().optional(),
	command: z.string().optional(),
	allContainers: z.boolean().optional(),
})

const zeropsYamlSchema = z.object({
	zerops: z.array(
		z.object({
			setup: z.string(),
			run: z.object({ start: z.string().optional(), crontab: z.array(crontabEntrySchema).optional() }).optional(),
		}),
	),
})

const JOB_COMMAND = /^fabrika job run (\S+)$/
/** A lone `&`, `nohup`, `setsid` or `disown` starts a process beside the server, outside every job rule. */
const BACKGROUND_PROCESS = /(?:^|[^&])&(?:[^&]|$)|\b(?:nohup|setsid|disown)\b/

/** The line of the first occurrence of `needle`, or 1. */
const lineOf = (text: string, needle: string, after = 0): number => {
	const index = text.indexOf(needle, after)
	return index === -1 ? 1 : text.slice(0, index).split('\n').length
}

/** Each setup that runs the application carries exactly the contract's jobs as crontab entries, and nothing else. */
export const checkCrontab = (file: string, text: string, jobs: readonly ContractJob[]): Finding[] => {
	const findings: Finding[] = []
	const finding = (line: number, message: string, allowed: string) => findings.push({ file, line, column: 1, rule: 'crontab', message, allowed })
	let document: unknown
	try {
		document = Bun.YAML.parse(text)
	} catch {
		finding(1, `${file} is not valid YAML`, 'a zerops.yaml that parses')
		return findings
	}
	const parsed = zeropsYamlSchema.safeParse(document)
	if (!parsed.success) {
		const issue = parsed.error.issues[0]
		finding(
			1,
			`${file} does not have the zerops.yaml shape at '${issue?.path.join('.') ?? ''}'`,
			'zerops: [{ setup, run: { start, crontab: [{ timing, command, allContainers }] } }]',
		)
		return findings
	}
	const byName = new Map(jobs.map((job) => [job.name, job]))
	for (const setup of parsed.data.zerops) {
		const { run } = setup
		if (run === undefined) continue
		const setupLine = lineOf(text, `setup: ${setup.setup}`)
		const crontabLine = lineOf(text, 'crontab:', text.indexOf(`setup: ${setup.setup}`))
		if (run.start !== undefined && BACKGROUND_PROCESS.test(run.start)) {
			finding(
				lineOf(text, run.start),
				`run.start of '${setup.setup}' starts a background process`,
				'one server process in run.start; background work is a job in the contract (c.cron)',
			)
		}
		const scheduled = new Set<string>()
		for (const entry of run.crontab ?? []) {
			const line = entry.command === undefined ? crontabLine : lineOf(text, entry.command)
			const name = JOB_COMMAND.exec(entry.command ?? '')?.[1]
			const job = name === undefined ? undefined : byName.get(name)
			if (job === undefined) {
				finding(
					line,
					`crontab entry '${entry.command ?? ''}' is not a job of the contract`,
					'fabrika job run <name> for a c.cron job declared in fabrika.contract.ts',
				)
				continue
			}
			if (scheduled.has(job.name)) finding(line, `job '${job.name}' has a second crontab entry`, 'one crontab entry per job')
			scheduled.add(job.name)
			if (entry.timing !== job.schedule) {
				finding(
					line,
					`crontab timing '${entry.timing ?? ''}' of job '${job.name}' differs from the contract's '${job.schedule ?? ''}'`,
					`timing: '${job.schedule ?? ''}'`,
				)
			}
			if (entry.allContainers !== false) {
				finding(line, `crontab entry of job '${job.name}' does not set allContainers: false`, 'allContainers: false, written explicitly')
			}
		}
		for (const job of jobs) {
			if (!scheduled.has(job.name)) {
				finding(
					run.crontab === undefined ? setupLine : crontabLine,
					`job '${job.name}' has no crontab entry in '${setup.setup}'`,
					`{ timing: '${job.schedule ?? ''}', command: 'fabrika job run ${job.name}', allContainers: false }`,
				)
			}
		}
	}
	return findings
}
