import type { IamSignInSignalsRpc, PrivilegedSignIn, SignInSignalsResult } from '@fabrika/auth-core'
import type { AlertsRepository, NotificationChannelRow, SecurityAlertsRepository, SourceRow } from './repositories.js'

/** Refused sign-ins are counted over this window before each pass's time, and an alert repeats at most this often. */
export const SECURITY_REFUSAL_WINDOW_MS = 15 * 60_000
export const SECURITY_ALERT_REPEAT_MS = 60 * 60_000
export const DEFAULT_ACCOUNT_REFUSAL_THRESHOLD = 5
export const DEFAULT_INSTALLATION_REFUSAL_THRESHOLD = 50
/** IAM answers at most a day; a pass that fell further behind reads the last day only. */
const MAX_LOOKBACK_MS = 24 * 60 * 60_000

export type SecurityAlertProductionResult =
	| { status: 'evaluated'; enqueued: number; deduplicated: number }
	/** No `security` rule with a channel on the installation source: IAM is not asked. */
	| { status: 'unconfigured' }
	| { status: 'skipped'; reason: 'no_installation_source' | 'iam_not_configured' | 'iam_unavailable' | 'failed' }

export interface SecurityAlertLogger {
	warn(message: string): void
}

export interface SecurityAlertProducerOptions {
	now?: () => number
	logger?: SecurityAlertLogger
}

/** IAM's sign-in signals, or nothing where this runtime has no IAM to ask. */
export type SignInSignalsSource = IamSignInSignalsRpc | undefined

let reportedMissingIam = false

/**
 * Raises `security` alerts on the installation source from IAM's sign-in signals: refused sign-ins per account and
 * installation-wide over the counting window before now (never longer, so a pass after an outage counts no more than a
 * normal one), and each privileged sign-in since the stored mark minus the window, so passes overlap; claims and outbox
 * dedup keys keep the overlap from alerting twice. When IAM does not answer, the mark stays and the next pass reads the
 * same time again; a cut privileged list moves the mark only to its last listed sign-in.
 */
export class OperationsSecurityAlertProducer {
	private readonly now: () => number
	private readonly logger: SecurityAlertLogger

	constructor(
		private readonly alerts: AlertsRepository,
		private readonly security: SecurityAlertsRepository,
		private readonly iam: SignInSignalsSource,
		options: SecurityAlertProducerOptions = {},
	) {
		this.now = options.now ?? Date.now
		this.logger = options.logger ?? { warn: (message) => console.warn(message) }
	}

	async run(): Promise<SecurityAlertProductionResult> {
		const source = await this.security.ensureInstallationSource()
		if (source === null) {
			this.logger.warn('operations security alerts skipped: another source holds the installation source coordinate')
			return { status: 'skipped', reason: 'no_installation_source' }
		}
		if (!await this.security.isConfigured(source.id)) {
			await this.security.reset()
			return { status: 'unconfigured' }
		}
		if (this.iam === undefined) {
			if (!reportedMissingIam) {
				reportedMissingIam = true
				this.logger.warn('operations security alerts skipped: no IAM is configured for Operations')
			}
			return { status: 'skipped', reason: 'iam_not_configured' }
		}
		const until = this.now()
		const mark = await this.security.evaluatedUntil() ?? until
		const since = Math.max(mark - SECURITY_REFUSAL_WINDOW_MS, until - MAX_LOOKBACK_MS)
		let signals: SignInSignalsResult | null
		try {
			signals = await this.iam.signInSignals({
				since: Math.floor(since / 1_000),
				refusalsSince: Math.floor((until - SECURITY_REFUSAL_WINDOW_MS) / 1_000),
				until: Math.floor(until / 1_000),
			})
		} catch {
			// An unreachable IAM and one older than the method look alike here; the error is not logged, it may quote a URL.
			signals = null
		}
		if (signals === null || !signals.ok) {
			this.logger.warn('operations security alerts skipped: IAM did not answer the sign-in signals; the next pass retries')
			return { status: 'skipped', reason: 'iam_unavailable' }
		}
		if (signals.accountsTruncated) this.logger.warn('operations security alerts: IAM cut the refusing accounts at its limit')
		const result = await this.raise(source, signals, { since: until - SECURITY_REFUSAL_WINDOW_MS, until })
		const last = signals.privileged.at(-1)
		// The next pass lists the rest; the overlap and the auth_log id dedup keep the re-read from alerting twice.
		await this.security.advance(signals.privilegedTruncated && last !== undefined ? last.at * 1_000 : until)
		return { status: 'evaluated', ...result }
	}

	private async raise(
		source: SourceRow,
		signals: Extract<SignInSignalsResult, { ok: true }>,
		window: { since: number; until: number },
	): Promise<{ enqueued: number; deduplicated: number }> {
		const config = await this.security.getConfig(source.id)
		const accountThreshold = config?.account_threshold ?? DEFAULT_ACCOUNT_REFUSAL_THRESHOLD
		const installationThreshold = config?.installation_threshold ?? DEFAULT_INSTALLATION_REFUSAL_THRESHOLD
		const channels = (await this.alerts.listChannels(source.id)).filter((channel) => channel.scope === 'security' && channel.enabled === 1)
		const repeatWindow = Math.floor(window.until / SECURITY_ALERT_REPEAT_MS)
		const outcome = { enqueued: 0, deduplicated: 0 }
		/** Enqueue under a claim; a failed enqueue gives the claim back, so the next pass raises the alert again. */
		const enqueueClaimed = async (claim: string, key: string, payload: Record<string, unknown>) => {
			if (!await this.alerts.tryClaim(claim, SECURITY_ALERT_REPEAT_MS)) {
				outcome.deduplicated++
				return
			}
			try {
				await enqueue(key, payload)
			} catch (error) {
				await this.alerts.releaseClaim(claim)
				throw error
			}
		}
		const enqueue = async (key: string, payload: Record<string, unknown>) => {
			for (const channel of channels) {
				if (await this.enqueue(source, channel, `${key}:${channel.id}`, payload)) outcome.enqueued++
				else outcome.deduplicated++
			}
		}

		for (const account of signals.accounts) {
			if (account.refusals < accountThreshold) continue
			await enqueueClaimed(
				`security:account:${source.id}:${account.principalId}`,
				`security:account:${source.id}:${account.principalId}:${repeatWindow}`,
				{
					text: `Fabrika Operations: ${account.refusals} refused sign-ins for account ${account.principalId} (threshold ${accountThreshold})`,
					type: 'security',
					signal: 'account_refusals',
					sourceId: source.id,
					principalId: account.principalId,
					refusals: account.refusals,
					threshold: accountThreshold,
					since: window.since,
					until: window.until,
				},
			)
		}

		if (signals.refusals >= installationThreshold) {
			await enqueueClaimed(`security:installation:${source.id}`, `security:installation:${source.id}:${repeatWindow}`, {
				text: `Fabrika Operations: ${signals.refusals} refused sign-ins across the installation (threshold ${installationThreshold})`,
				type: 'security',
				signal: 'installation_refusals',
				sourceId: source.id,
				refusals: signals.refusals,
				threshold: installationThreshold,
				reasons: signals.reasons,
				since: window.since,
				until: window.until,
			})
		}

		for (const signIn of signals.privileged) {
			await enqueue(`security:privileged:${source.id}:${signIn.id}`, privilegedPayload(source.id, signIn))
		}
		return outcome
	}

	private enqueue(source: SourceRow, channel: NotificationChannelRow, dedupKey: string, payload: Record<string, unknown>): Promise<boolean> {
		return this.alerts.enqueueNotification({ dedupKey, sourceId: source.id, channelId: channel.id, kind: 'security', payload })
	}
}

function privilegedPayload(sourceId: string, signIn: PrivilegedSignIn): Record<string, unknown> {
	return {
		text: `Fabrika Operations: privileged sign-in by ${signIn.principalId}`,
		type: 'security',
		signal: 'privileged_sign_in',
		sourceId,
		principalId: signIn.principalId,
		authLogId: signIn.id,
		reason: signIn.reason,
		at: signIn.at * 1_000,
	}
}
