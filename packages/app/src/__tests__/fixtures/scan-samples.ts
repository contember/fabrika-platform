// Files the scan tests hand to a scanner: harmless, and each answered the same by every ClamAV.

import { deflateRawSync } from 'node:zlib'

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

export interface ZipEntry {
	readonly name: string
	readonly bytes: Uint8Array | string
	/** `stored` keeps the bytes; `deflate` compresses them; a number writes that method over the stored bytes. */
	readonly method?: 'stored' | 'deflate' | number
	/** Bit 3 writes the sizes and CRC in a data descriptor after the data, as a streaming writer does. */
	readonly flags?: number
}

/**
 * A ZIP archive of `entries`, written as the format says: local headers, data (and a data descriptor when bit 3 is
 * set), the directory and its end record, with `comment` after it.
 */
export function zipOf(entries: readonly ZipEntry[], comment: Uint8Array = new Uint8Array()): Uint8Array<ArrayBuffer> {
	const u16 = (value: number) => [value & 0xff, (value >> 8) & 0xff]
	const u32 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]
	const local: number[] = []
	const central: number[] = []
	for (const entry of entries) {
		const name = new TextEncoder().encode(entry.name)
		const content = typeof entry.bytes === 'string' ? new TextEncoder().encode(entry.bytes) : entry.bytes
		const method = entry.method === 'deflate' ? 8 : entry.method === undefined || entry.method === 'stored' ? 0 : entry.method
		const data = entry.method === 'deflate' ? deflateRawSync(content) : content
		const flags = entry.flags ?? 0
		const sizes = [...u32(Bun.hash.crc32(content)), ...u32(data.length), ...u32(content.length)]
		const described = (flags & 0x08) !== 0
		const header = (
			withSizes: boolean,
		) => [...u16(20), ...u16(flags), ...u16(method), ...u16(0), ...u16(0), ...(withSizes ? sizes : u32(0).concat(u32(0), u32(0))), ...u16(name.length)]
		const offset = local.length
		local.push(...u32(0x04034b50), ...header(!described), ...u16(0), ...name, ...data, ...(described ? [...u32(0x08074b50), ...sizes] : []))
		central.push(...u32(0x02014b50), ...u16(20), ...header(true), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name)
	}
	const end = [
		...u32(0x06054b50),
		...u16(0),
		...u16(0),
		...u16(entries.length),
		...u16(entries.length),
		...u32(central.length),
		...u32(local.length),
		...u16(comment.length),
	]
	return new Uint8Array([...local, ...central, ...end, ...comment])
}

/** A deflated EICAR whose compressed stream is corrupted, its CRC and sizes left as they were. */
export function damagedZip(): Uint8Array<ArrayBuffer> {
	const zip = zipOf([{ name: 'eicar.txt', bytes: EICAR, method: 'deflate' }])
	const data = 30 + 'eicar.txt'.length
	for (let at = data + 2; at < data + 12; at++) zip[at] = (zip[at] ?? 0) ^ 0x5a
	return zip
}

/** A valid ZIP whose one entry is EICAR compressed with LZMA (method 14), as Python's `zipfile.ZIP_LZMA` writes it. */
export const LZMA_EICAR_ZIP: Uint8Array<ArrayBuffer> = Uint8Array.from(
	atob(
		'UEsDBD8AAgAOALeGTF08z1FoVgAAAEQAAAAJAAAAZWljYXIudHh0CQQFAF0AAIAAACwNReIjSzgJ/iQsW0s2kDHcSyQ1tjLfrzFMPN/POkt1c+WLyH6Js4Be95QfjanDHvpJbAX8hAVacfw5upJli5dDp914UJe//8QYoABQSwECPwM/AAIADgC3hkxdPM9RaFYAAABEAAAACQAAAAAAAAAAAAAAgAEAAAAAZWljYXIudHh0UEsFBgAAAAABAAEANwAAAH0AAAAAAA==',
	),
	(char) => char.charCodeAt(0),
)
