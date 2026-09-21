export function githubRecoverySecretLabel(attemptId: string): string {
	return `platform:github-source:${attemptId}:recovery`
}

export function githubManifestStateSecretLabel(attemptId: string): string {
	return `platform:github-source:${attemptId}:manifest-state`
}

export function githubWebhookSecretLabel(connectionId: string): string {
	return `platform:github-source:${connectionId}:webhook`
}
