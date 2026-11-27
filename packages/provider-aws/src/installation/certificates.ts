// The installation's four certificates (the AWS idea's checklist, step 11, the commands' step): IAM's, Control's and
// Operations' on the platform balancer, and the applications' listener's default on the applications' balancer.
//
// - **Exactly its host.** Each certificate names its own host and nothing else: no wildcard, no other name beside it.
//   A balancer serves a certificate to every client whose SNI it matches, so a certificate that also covered a
//   platform host, put on the applications' listener, would let a rule Control's role writes serve that host
//   (`balancers.ts`). A named one is read back and refused when it names another host, several, or none ACM
//   describes; when it is another account's or region's (a balancer takes only its own region's); or when it is not
//   issued, or about to be.
// - **An install requests what is missing.** A host named without a certificate takes the newest one the account
//   holds for exactly that host, issued or waiting for its DNS record; with none, the install requests one, validated
//   by DNS, after the operator's one confirmation. Until every one is issued, the install prints the records to add and
//   stops before any stack; run again, it finds the same certificates and goes on. An install resumed from its record
//   takes the record's certificates, never a new one.
// - **An upgrade requests nothing.** Each certificate is the record's or the one named, checked the same way; one no
//   longer issued (expired, revoked) is refused, naming the flag that replaces it.
// - Nothing tags or deletes a certificate: one the installation no longer uses is the operator's to delete.

import { createHash } from 'node:crypto'
import { type AcmPlatformCertificates, type Certificate, CERTIFICATE_ARN } from '../aws/acm'
import { AwsError } from '../aws/json'
import type { AwsPlatformPlan } from './apply'

/** The installation's four certificates, by the host each serves. */
export type AwsCertificateSlot = 'iam' | 'control' | 'operations' | 'apps'
export const AWS_CERTIFICATE_SLOTS: readonly AwsCertificateSlot[] = ['iam', 'control', 'operations', 'apps']

/** How often, and how long apart, a fresh request is read again for the DNS record ACM names a moment later. */
const RECORD_READS = 12
const RECORD_READ_INTERVAL_MS = 5_000

/** The flag that names each slot's certificate, for a refusal to point at. */
const FLAG: Readonly<Record<AwsCertificateSlot, string>> = {
	iam: '--iam-certificate',
	control: '--control-certificate',
	operations: '--operations-certificate',
	apps: '--apps-certificate',
}

/** Each slot's host in a plan. */
export function awsPlanHosts(plan: Pick<AwsPlatformPlan, 'hosts' | 'appsDefault'>): Readonly<Record<AwsCertificateSlot, string>> {
	return { iam: plan.hosts.iam, control: plan.hosts.control, operations: plan.hosts.operations, apps: plan.appsDefault.host }
}

/** Each slot's certificate in a plan. */
export function awsPlanCertificates(plan: Pick<AwsPlatformPlan, 'certificates' | 'appsDefault'>): Readonly<Record<AwsCertificateSlot, string>> {
	return { ...plan.certificates, apps: plan.appsDefault.certificate }
}

/** Where the run looks: the account and region a balancer there takes certificates from, and ACM's calls. */
export interface AwsCertificatesWhere {
	readonly accountId: string
	readonly region: string
	readonly acm: Pick<AcmPlatformCertificates, 'describeCertificate' | 'findCertificates' | 'requestCertificate'>
	readonly signal: AbortSignal
}

/**
 * `arn` read back as `slot`'s certificate for `host`, refused when it is another account's or region's, when ACM has
 * none, or when it names anything but `host` alone. Its status is the caller's to judge.
 */
export async function checkedAwsCertificate(where: AwsCertificatesWhere, slot: AwsCertificateSlot, host: string, arn: string): Promise<Certificate> {
	const flag = FLAG[slot]
	if (!CERTIFICATE_ARN.test(arn)) throw new Error(`aws: ${flag} is not a certificate's ARN`)
	const [, , , region, account] = arn.split(':')
	if (region !== where.region || account !== where.accountId) {
		throw new Error(`aws: ${flag} ${arn} is account ${account}'s in ${region}; a balancer in ${where.region} takes its own account's and region's`)
	}
	let certificate: Certificate | null
	try {
		certificate = await where.acm.describeCertificate(arn, where.signal)
	} catch (error) {
		// ACM's answer names several hosts, a wildcard, or one of another form: never exactly one host.
		if (error instanceof AwsError && error.code === 'invalid_answer') {
			throw new Error(`aws: ${flag} ${arn} is not a certificate of exactly ${host}; each certificate names its own host alone`)
		}
		throw error
	}
	if (certificate === null) throw new Error(`aws: ${flag} ${arn} is no certificate in account ${where.accountId}, ${where.region}`)
	if (certificate.host !== host) throw new Error(`aws: ${flag} ${arn} is ${certificate.host}'s, not ${host}'s`)
	return certificate
}

/** A slot's certificate as the run settled it: read back, or `null` while still to request. */
export interface AwsSettledCertificate {
	readonly slot: AwsCertificateSlot
	readonly host: string
	readonly certificate: Certificate | null
}

/** A slot's certificate read back. */
export interface AwsSlotCertificate extends AwsSettledCertificate {
	readonly certificate: Certificate
}

/**
 * An install's, reading and never writing: each slot's certificate from `chosen` (named, or the record's), checked;
 * else the newest the account holds for exactly its host; else none, to request.
 */
export async function settleAwsCertificates(
	where: AwsCertificatesWhere,
	hosts: Readonly<Record<AwsCertificateSlot, string>>,
	chosen: Readonly<Partial<Record<AwsCertificateSlot, string>>>,
): Promise<readonly AwsSettledCertificate[]> {
	const settled: AwsSettledCertificate[] = []
	for (const slot of AWS_CERTIFICATE_SLOTS) {
		const host = hosts[slot]
		const arn = chosen[slot] ?? (await where.acm.findCertificates(host, where.signal))[0]?.arn
		settled.push({ slot, host, certificate: arn === undefined ? null : await checkedAwsCertificate(where, slot, host, arn) })
	}
	return settled
}

/** An upgrade's: each slot's certificate, the record's or the one named, checked. */
export async function checkedAwsCertificates(
	where: AwsCertificatesWhere,
	plan: Pick<AwsPlatformPlan, 'hosts' | 'certificates' | 'appsDefault'>,
): Promise<readonly AwsSlotCertificate[]> {
	const hosts = awsPlanHosts(plan)
	const arns = awsPlanCertificates(plan)
	const checked: AwsSlotCertificate[] = []
	for (const slot of AWS_CERTIFICATE_SLOTS) {
		checked.push({ slot, host: hosts[slot], certificate: await checkedAwsCertificate(where, slot, hosts[slot], arns[slot]) })
	}
	return checked
}

/** Every slot read back, or `null` while one is still to request. */
export function everyAwsCertificate(settled: readonly AwsSettledCertificate[]): readonly AwsSlotCertificate[] | null {
	const certificates: AwsSlotCertificate[] = []
	for (const { slot, host, certificate } of settled) {
		if (certificate === null) return null
		certificates.push({ slot, host, certificate })
	}
	return certificates
}

/** The idempotency token of a host's request: the same host asks for the same certificate within ACM's hour. */
export function awsCertificateToken(host: string): string {
	return createHash('sha256').update(`fabrika-platform-certificate:${host}`, 'utf8').digest('hex').slice(0, 32)
}

/**
 * Requests a certificate, validated by DNS, for each slot that has none, and reads each back until ACM names the record
 * to add (or the reads run out). Answers every slot's certificate.
 */
export async function requestAwsCertificates(
	where: AwsCertificatesWhere & {
		readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
		readonly log: (line: string) => void
	},
	settled: readonly AwsSettledCertificate[],
): Promise<readonly AwsSlotCertificate[]> {
	const answered: AwsSlotCertificate[] = []
	for (const entry of settled) {
		if (entry.certificate !== null) {
			answered.push({ slot: entry.slot, host: entry.host, certificate: entry.certificate })
			continue
		}
		const arn = await where.acm.requestCertificate({ host: entry.host, token: awsCertificateToken(entry.host) }, where.signal)
		where.log(`aws: requested a certificate for ${entry.host}: ${arn}`)
		let certificate = await checkedAwsCertificate(where, entry.slot, entry.host, arn)
		for (let read = 1; read < RECORD_READS && certificate.validation === null && certificate.status === 'PENDING_VALIDATION'; read++) {
			await where.sleep(RECORD_READ_INTERVAL_MS, where.signal)
			certificate = await checkedAwsCertificate(where, entry.slot, entry.host, arn)
		}
		answered.push({ slot: entry.slot, host: entry.host, certificate })
	}
	return answered
}

/**
 * Whether every certificate is issued. A pending one's record is logged to add, and kept: ACM renews with it. Any other
 * status (expired, revoked, failed, timed out) is refused, naming the flag that replaces it.
 */
export function awsCertificatesIssued(
	certificates: readonly AwsSlotCertificate[],
	log: (line: string) => void,
): boolean {
	let issued = true
	for (const { slot, host, certificate } of certificates) {
		if (certificate.status === 'ISSUED') continue
		if (certificate.status !== 'PENDING_VALIDATION') {
			throw new Error(`aws: the certificate for ${host} (${certificate.arn}) is ${certificate.status}; name another with ${FLAG[slot]}`)
		}
		issued = false
		log(
			certificate.validation === null
				? `aws: ${host}: ACM has not named its DNS record yet (${certificate.arn}); run again in a minute to see it`
				: `aws: ${host}: add the DNS record CNAME ${certificate.validation.name} -> ${certificate.validation.value}`,
		)
	}
	return issued
}
