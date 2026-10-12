// Files the scan tests hand to a scanner: harmless, and each answered the same by every ClamAV.

/** The EICAR test file: every antivirus reports it, and it is harmless. */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
export const CLEAN_PDF = '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'

/** A zip whose one entry carries the encryption flag: its content cannot be scanned. */
export function encryptedZip(): Uint8Array<ArrayBuffer> {
	const name = new TextEncoder().encode('secret.txt')
	const data = crypto.getRandomValues(new Uint8Array(12 + 64))
	const u16 = (value: number) => [value & 0xff, (value >> 8) & 0xff]
	const u32 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]
	const common = [...u16(20), ...u16(1), ...u16(0), ...u16(0), ...u16(0), ...u32(0x12345678), ...u32(data.length), ...u32(64), ...u16(name.length)]
	const local = [...u32(0x04034b50), ...common, ...u16(0), ...name, ...data]
	const central = [...u32(0x02014b50), ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...name]
	const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(1), ...u16(1), ...u32(central.length), ...u32(local.length), ...u16(0)]
	return new Uint8Array([...local, ...central, ...end])
}
