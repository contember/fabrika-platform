let lastMillis = -1
let counter = 0

export function uuidv7(millis: number = Date.now()): string {
	const bytes = new Uint8Array(16)
	crypto.getRandomValues(bytes)
	if (millis > lastMillis) {
		lastMillis = millis
		counter = bytes[7] ?? 0
	} else if (counter < 0xfff) {
		counter++
	} else {
		lastMillis++
		counter = bytes[7] ?? 0
	}
	bytes[0] = (lastMillis / 2 ** 40) & 0xff
	bytes[1] = (lastMillis / 2 ** 32) & 0xff
	bytes[2] = (lastMillis / 2 ** 24) & 0xff
	bytes[3] = (lastMillis / 2 ** 16) & 0xff
	bytes[4] = (lastMillis / 2 ** 8) & 0xff
	bytes[5] = lastMillis & 0xff
	bytes[6] = 0x70 | (counter >>> 8)
	bytes[7] = counter & 0xff
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
