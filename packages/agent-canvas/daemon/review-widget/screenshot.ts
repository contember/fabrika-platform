/** The smallest surroundings worth showing around a picked element, and the tallest an ancestor may be to count as them. */
const MIN_CONTEXT = { width: 480, height: 160 }
const MAX_CONTEXT_HEIGHT = 900
const OUTLINE = '#e11d48'

/** The nearest ancestor large enough to show where the element sits, but not a whole scrolling page. */
function surroundingsOf(element: Element): Element {
	let context = element
	for (let parent = element.parentElement; parent !== null && parent !== element.ownerDocument.body; parent = parent.parentElement) {
		const box = context.getBoundingClientRect()
		if (box.width >= MIN_CONTEXT.width && box.height >= MIN_CONTEXT.height) break
		if (parent.getBoundingClientRect().height > MAX_CONTEXT_HEIGHT) break
		context = parent
	}
	return context
}

/** Resolves once the stream has delivered `count` new frames, so the frame drawn shows the page after our changes. */
function streamFrames(video: HTMLVideoElement, count: number): Promise<void> {
	return new Promise((resolve) => {
		const fallback = setTimeout(resolve, 1000)
		const wait = (left: number) => {
			if (left === 0) {
				clearTimeout(fallback)
				resolve()
				return
			}
			video.requestVideoFrameCallback(() => wait(left - 1))
		}
		wait(count)
	})
}

function clip(box: DOMRect): { left: number; top: number; width: number; height: number } {
	const left = Math.max(0, box.left)
	const top = Math.max(0, box.top)
	return { left, top, width: Math.min(innerWidth, box.right) - left, height: Math.min(innerHeight, box.bottom) - top }
}

/**
 * Real pixels of the element in its surroundings, the element outlined, the widget hidden: the browser asks the
 * reviewer to share this tab for one frame. Rendering the DOM into a picture instead gets fonts and text wrapping
 * wrong, which is exactly what a visual comment is about.
 *
 * Call it straight from the click handler: the browser lets a page ask for the tab only during a user gesture.
 */
export async function captureElement(element: Element, widgetHost: HTMLElement): Promise<string> {
	// Hidden before the stream starts: its first frames already lack the widget, later ones can lag behind the page.
	const previousVisibility = widgetHost.style.visibility
	widgetHost.style.visibility = 'hidden'
	element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
	let stream: MediaStream
	try {
		stream = await navigator.mediaDevices.getDisplayMedia({
			video: { displaySurface: 'browser', width: { ideal: innerWidth * devicePixelRatio }, height: { ideal: innerHeight * devicePixelRatio } },
			audio: false,
			// Chrome's options for sharing the page's own tab without a picker; other browsers ignore them.
			...{ preferCurrentTab: true, selfBrowserSurface: 'include' },
		})
	} catch (error) {
		widgetHost.style.visibility = previousVisibility
		throw error
	}
	try {
		const [track] = stream.getVideoTracks()
		if (track === undefined || track.getSettings().displaySurface !== 'browser') throw new Error('Share this tab to attach a screenshot')
		const video = document.createElement('video')
		video.muted = true
		video.srcObject = stream
		await video.play()
		await streamFrames(video, 2)

		const context = clip(surroundingsOf(element).getBoundingClientRect())
		const target = element.getBoundingClientRect()
		// The captured frame is the tab's viewport at the device's pixel density.
		const ratio = video.videoWidth / innerWidth
		const canvas = document.createElement('canvas')
		canvas.width = Math.round(context.width * ratio)
		canvas.height = Math.round(context.height * ratio)
		const drawing = canvas.getContext('2d')
		if (drawing === null) throw new Error('Canvas is not available')
		drawing.drawImage(video, context.left * ratio, context.top * ratio, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height)
		drawing.strokeStyle = OUTLINE
		drawing.lineWidth = 3 * ratio
		drawing.strokeRect((target.left - context.left) * ratio, (target.top - context.top) * ratio, target.width * ratio, target.height * ratio)
		return canvas.toDataURL('image/png')
	} finally {
		widgetHost.style.visibility = previousVisibility
		for (const track of stream.getTracks()) track.stop()
	}
}
