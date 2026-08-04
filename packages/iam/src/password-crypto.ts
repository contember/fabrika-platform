export const PBKDF2_SHA256_ALGORITHM = 'pbkdf2-sha256'
export const PBKDF2_SHA256_ITERATIONS = 600_000
export const PBKDF2_SHA256_SALT_BYTES = 16
export const PBKDF2_SHA256_OUTPUT_BYTES = 32

export interface StoredPasswordHash {
	algorithm: string
	parameters: string
	salt: string
	passwordHash: string
}

export interface PasswordVerification {
	valid: boolean
	needsRehash: boolean
}

export interface PasswordHasher {
	hash(password: string): Promise<StoredPasswordHash>
	verify(password: string, stored: StoredPasswordHash): Promise<PasswordVerification>
}

interface Pbkdf2Parameters {
	iterations: number
	outputBytes: number
}

const CURRENT_PARAMETERS: Pbkdf2Parameters = {
	iterations: PBKDF2_SHA256_ITERATIONS,
	outputBytes: PBKDF2_SHA256_OUTPUT_BYTES,
}

function encodeHex(bytes: Uint8Array): string {
	let value = ''
	for (const byte of bytes) {
		value += byte.toString(16).padStart(2, '0')
	}
	return value
}

function decodeHex(value: string): Uint8Array<ArrayBuffer> | null {
	if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
		return null
	}
	const bytes = new Uint8Array(value.length / 2)
	for (let index = 0; index < bytes.length; index += 1) {
		const byte = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
		if (!Number.isFinite(byte)) {
			return null
		}
		bytes[index] = byte
	}
	return bytes
}

function parseParameters(value: string): Pbkdf2Parameters | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch {
		return null
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return null
	}
	const iterations = Reflect.get(parsed, 'iterations')
	const outputBytes = Reflect.get(parsed, 'outputBytes')
	if (!Number.isSafeInteger(iterations) || typeof iterations !== 'number' || iterations <= 0 || iterations > 10_000_000) {
		return null
	}
	if (!Number.isSafeInteger(outputBytes) || typeof outputBytes !== 'number' || outputBytes <= 0 || outputBytes > 128) {
		return null
	}
	return { iterations, outputBytes }
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, parameters: Pbkdf2Parameters): Promise<Uint8Array<ArrayBuffer>> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: parameters.iterations },
		key,
		parameters.outputBytes * 8,
	)
	return new Uint8Array(bits)
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
	let difference = left.length ^ right.length
	const length = Math.max(left.length, right.length)
	for (let index = 0; index < length; index += 1) {
		difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
	}
	return difference === 0
}

export class WebCryptoPasswordHasher implements PasswordHasher {
	async hash(password: string): Promise<StoredPasswordHash> {
		const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SHA256_SALT_BYTES))
		const passwordHash = await derive(password, salt, CURRENT_PARAMETERS)
		return {
			algorithm: PBKDF2_SHA256_ALGORITHM,
			parameters: JSON.stringify(CURRENT_PARAMETERS),
			salt: encodeHex(salt),
			passwordHash: encodeHex(passwordHash),
		}
	}

	async verify(password: string, stored: StoredPasswordHash): Promise<PasswordVerification> {
		if (stored.algorithm !== PBKDF2_SHA256_ALGORITHM) {
			return { valid: false, needsRehash: false }
		}
		const parameters = parseParameters(stored.parameters)
		const salt = decodeHex(stored.salt)
		const expected = decodeHex(stored.passwordHash)
		if (parameters === null || salt === null || expected === null) {
			return { valid: false, needsRehash: false }
		}
		const actual = await derive(password, salt, parameters)
		const valid = constantTimeEqual(actual, expected)
		const needsRehash = valid
			&& (parameters.iterations !== CURRENT_PARAMETERS.iterations
				|| parameters.outputBytes !== CURRENT_PARAMETERS.outputBytes
				|| salt.length !== PBKDF2_SHA256_SALT_BYTES)
		return { valid, needsRehash }
	}
}
