// The slides' screenshots of the orders demo, through the installed Google Chrome, against a running `fabrika app dev`
// (default http://127.0.0.1:3000) and the approval preview beside this file. Writes PNGs into ./screenshots.
//
// Run from the repository root, with app dev already running from a fresh start (its seed, nothing clicked yet):
//   bun examples/orders-demo/screenshots.ts [origin]
// It deletes nothing: the refused delete leaves the order in place.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'

const origin = process.argv[2] ?? 'http://127.0.0.1:3000'
const out = join(import.meta.dir, 'screenshots')
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'cs-CZ' })

async function shot(name: string, target: Page = page): Promise<void> {
	await target.waitForLoadState('networkidle')
	await target.screenshot({ path: join(out, `${name}.png`) })
	console.info(`${name}.png`)
}

/** Becomes `persona` as the dev toolbar does, then opens `path`. */
async function as(persona: string, path: string): Promise<void> {
	await page.goto(`${origin}/__fabrika/dev/as?persona=${encodeURIComponent(persona)}&next=${encodeURIComponent(path)}`)
	await page.waitForSelector('tbody tr, h1')
}

try {
	await page.goto(`${origin}/__fabrika/dev`)
	await shot('01-persony')

	await as('Jana', '/')
	await page.waitForSelector('text=OBJ-2026-0412')
	await shot('02-objednavky-majitelka')
	await as('Jana', '/odberatele')
	await page.waitForSelector('text=Restaurace Stará pošta')
	await shot('03-odberatele-majitelka')

	await as('Petr', '/odberatele')
	await page.waitForSelector('text=Kavárna U Modré lípy')
	await shot('04-odberatele-obchodnik')
	await as('Petr', '/')
	await page.waitForSelector('text=OBJ-2026-0412')
	await shot('05-objednavky-obchodnik')

	await as('Lenka', '/')
	await page.waitForSelector('text=OBJ-2026-0412')
	await shot('06-objednavky-uctarna')
	await page.click('button[aria-label="Smazat OBJ-2026-0412"]')
	await page.waitForSelector('[role="dialog"]')
	await shot('07-uctarna-potvrzuje-smazani')
	await page.locator('[role="dialog"] button', { hasText: 'Smazat' }).click()
	await page.waitForSelector('.orders-refusal')
	await shot('08-uctarna-odmitnuto')
	await as('Lenka', '/fakturace')
	await page.waitForSelector('text=FV-2026-0187')
	await shot('09-fakturace-uctarna')

	const approval = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
	await approval.goto(`file://${join(import.meta.dir, 'approval-preview.html')}`)
	await approval.screenshot({ path: join(out, '10-schvaleni-kdo-ziska-pristup.png'), fullPage: true })
	console.info('10-schvaleni-kdo-ziska-pristup.png')
} finally {
	await browser.close()
}
