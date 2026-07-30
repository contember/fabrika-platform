import { createZeropsEmulator } from './zerops-emulator'

const token = required('LOCAL_ZEROPS_TOKEN')
const port = parsePort(process.env['PORT'])
const activationDelayMs = parseNonNegativeInteger('LOCAL_ZEROPS_ACTIVATION_DELAY_MS', process.env['LOCAL_ZEROPS_ACTIVATION_DELAY_MS'])
const fetch = await createZeropsEmulator({
	token,
	activationDelayMs,
	...(process.env['LOCAL_ZEROPS_STATE_FILE'] === undefined ? {} : { stateFile: process.env['LOCAL_ZEROPS_STATE_FILE'] }),
})

const server = Bun.serve({
	hostname: '0.0.0.0',
	port,
	fetch,
})

console.info(`Zerops emulator listening on ${server.port}`)

const shutdown = async (): Promise<void> => {
	await server.stop(false)
	process.exit(0)
}

process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

function required(name: string): string {
	const value = process.env[name]
	if (value === undefined || value.trim() === '') {
		throw new Error(`${name} is required`)
	}
	return value
}

function parsePort(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === '') {
		return 3000
	}
	const value = Number.parseInt(raw, 10)
	if (!Number.isInteger(value) || value < 1 || value > 65535) {
		throw new Error('PORT must be an integer between 1 and 65535')
	}
	return value
}

function parseNonNegativeInteger(name: string, raw: string | undefined): number {
	if (raw === undefined || raw.trim() === '') {
		return 0
	}
	const value = Number.parseInt(raw, 10)
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${name} must be a non-negative integer`)
	}
	return value
}
