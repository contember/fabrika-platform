// highlight.js and mermaid reach the page as <script> tags from the host, not through the bundle.

interface HighlightJs {
	highlightElement(element: HTMLElement): void
}

interface MermaidApi {
	initialize(config: { startOnLoad: boolean; theme: string }): void
	render(id: string, source: string): Promise<{ svg: string }>
}

declare global {
	interface Window {
		hljs?: HighlightJs
		mermaid?: MermaidApi
	}
}

export function pageHighlighter(): HighlightJs | undefined {
	return window.hljs
}

export function pageMermaid(): MermaidApi | undefined {
	return window.mermaid
}
