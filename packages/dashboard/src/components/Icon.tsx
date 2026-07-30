// The console's icon set lives in `@fabrika/iam-ui` so the access pages can draw from it too; the
// dashboard re-exports it here so every route keeps one import path. Only the brand mark is local —
// it is this app's identity, not a shared glyph.

export { Icon, type IconName } from '@fabrika/iam-ui/icon'

/**
 * The fabrika mark: the sawtooth (northlight) roof of a factory hall — the product's name drawn
 * literally. Solid rather than stroked, because at 20px a 1.75px outline of this shape closes up into
 * a smudge; the filled silhouette stays legible and is the console's only piece of decoration.
 */
export function BrandMark({ size = 26 }: { size?: number }) {
	return (
		<svg
			className="brand-glyph"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
			focusable="false"
		>
			{/* Three bays under a sawtooth roof, sitting on the shop floor. */}
			<path d="M1.5 18.5V4.75L8 10.5V4.75L14.5 10.5V4.75L21 10.5v8z" />
			<rect x="1.5" y="20.25" width="19.5" height="2" rx="1" opacity="0.4" />
		</svg>
	)
}
