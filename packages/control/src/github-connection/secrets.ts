export function githubAppCredentialSecretLabel(connectionId: string): string {
	return `platform:github-source:${connectionId}:app-credential`
}

export function githubManifestStateSecretLabel(attemptId: string): string {
	return `platform:github-source:${attemptId}:manifest-state`
}

export function githubWebhookSecretLabel(connectionId: string): string {
	return `platform:github-source:${connectionId}:webhook`
}
