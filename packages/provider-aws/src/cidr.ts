// IPv4 blocks as the provider's network uses them: a VPC's and its subnets' (a /16 to a /28), named by their network
// address. Shared by the namespace's check of the installation's balancer (`namespace.ts`) and the installation's own
// network (`installation/network.ts`).

/** An IPv4 CIDR block of a VPC's or a subnet's size (a /16 to a /28). */
export const VPC_CIDR = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\/(?:1[6-9]|2[0-8])$/

/** The first address of `cidr` (of the `VPC_CIDR` form) as a number, and its prefix length. */
export function blockOf(cidr: string): { readonly start: number; readonly prefix: number } {
	const [address = '', prefix = ''] = cidr.split('/')
	return { start: address.split('.').reduce((sum, octet) => sum * 256 + Number(octet), 0), prefix: Number(prefix) }
}

/** Whether `cidr` (of the `VPC_CIDR` form) names its network address: no bit is set past its prefix, as a VPC's block. */
export function isNetworkAddress(cidr: string): boolean {
	const { start, prefix } = blockOf(cidr)
	return start % 2 ** (32 - prefix) === 0
}

/** Whether the block `inner` lies inside the block `outer`, both named by their network address. */
export function blockContains(outer: string, inner: string): boolean {
	const a = blockOf(outer)
	const b = blockOf(inner)
	return b.prefix >= a.prefix && Math.floor(b.start / 2 ** (32 - a.prefix)) === a.start / 2 ** (32 - a.prefix)
}

/** Whether two blocks share an address: one lies inside the other, since both are aligned to their prefix. */
export function blocksOverlap(a: string, b: string): boolean {
	return blockContains(a, b) || blockContains(b, a)
}

/** The block `prefix` bits long at `offset` addresses past the start of `outer`, as `a.b.c.d/prefix`. */
export function blockAt(outer: string, offset: number, prefix: number): string {
	const start = blockOf(outer).start + offset
	return `${[24, 16, 8, 0].map((shift) => Math.floor(start / 2 ** shift) % 256).join('.')}/${prefix}`
}
