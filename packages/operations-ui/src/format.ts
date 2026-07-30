const SEVERITY_COLORS: Record<string, string> = {
	fatal: 'var(--severity-fatal)',
	error: 'var(--severity-error)',
	warning: 'var(--severity-warning)',
	info: 'var(--severity-info)',
}

export function severityColor(level: string): string {
	return SEVERITY_COLORS[level] ?? 'var(--severity-muted)'
}

export function relativeSeen(timestamp: number, now: number = Date.now()): string {
	if (!timestamp) return '—'
	const difference = now - timestamp
	if (difference < 0) return 'now'
	const minutes = Math.floor(difference / 60_000)
	if (minutes < 1) return 'just now'
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	const days = Math.floor(hours / 24)
	if (days < 30) return `${days}d ago`
	return new Date(timestamp).toISOString().slice(0, 10)
}

export function formatTimestamp(timestamp: number | null): string {
	if (!timestamp) return '—'
	return `${new Date(timestamp).toISOString().replace('T', ' ').slice(0, 19)} UTC`
}
