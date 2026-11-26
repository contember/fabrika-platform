import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'

const SCRAM_ITERATIONS = 4096

/**
 * Postgres' SCRAM-SHA-256 verifier (RFC 7677) of `password`, for `CREATE ROLE … PASSWORD '<verifier>'`: the password
 * itself never reaches the server, so no statement log holds it.
 */
export function scramVerifier(password: string): string {
	const salt = randomBytes(16)
	const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, 'sha256')
	const storedKey = createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest()
	const serverKey = createHmac('sha256', salted).update('Server Key').digest()
	return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}
