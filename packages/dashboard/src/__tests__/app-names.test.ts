import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppName, appNames, AppNamesProvider, appOptionLabel, appText } from '../access/lib/app-names'

const APPS = [{ id: 'vozka', displayName: 'Console' }, { id: 'notes@prod', displayName: null }]

describe('IAM application names', () => {
	test('a named app renders its name, with its id in the tooltip', () => {
		const markup = renderToStaticMarkup(createElement(AppNamesProvider, { names: appNames(APPS) }, createElement(AppName, { app: 'vozka' })))
		expect(markup).toBe('<span title="vozka">Console</span>')
	})

	test('an app that declares no name, or one IAM did not list, renders its id', () => {
		const names = appNames(APPS)
		expect(renderToStaticMarkup(createElement(AppNamesProvider, { names }, createElement(AppName, { app: 'notes@prod' })))).toBe('notes@prod')
		expect(renderToStaticMarkup(createElement(AppName, { app: 'vozka' }))).toBe('vozka')
		expect(appText(names, 'unknown')).toBe('unknown')
	})

	test('a picker option keeps the id beside the name', () => {
		expect(APPS.map(appOptionLabel)).toEqual(['Console (vozka)', 'notes@prod'])
	})
})
