import type { WebhookSecretProvider } from '../repo-source'
import { type Vault } from '../vault'
import { githubWebhookSecretLabel } from './secrets'
import type { GitHubConnectionStore } from './store'

/** Reads the named connection on every delivery, so rotation takes effect without a restart. */
export class GitHubConnectionWebhookSecretProvider implements WebhookSecretProvider {
	constructor(
		private readonly store: GitHubConnectionStore,
		private readonly vault: Vault | (() => Promise<Vault>),
		private readonly connectionId: string,
	) {}

	async getSecret(signal?: AbortSignal): Promise<string | null> {
		throwIfAborted(signal)
		const binding = await this.store.getWebhookSecretBindingByConnectionId(this.connectionId)
		throwIfAborted(signal)
		if (binding === null) return null
		const secretVault = typeof this.vault === 'function' ? await this.vault() : this.vault
		const secret = await secretVault.getSecretForPurpose(binding.webhookSecretRef, {
			scope: 'platform',
			label: githubWebhookSecretLabel(binding.connectionId),
		})
		throwIfAborted(signal)
		return secret
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
}
