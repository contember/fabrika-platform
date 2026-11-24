// The strict XML reader: an AWS query-protocol answer read into elements and text, and every construct it refuses
// (a DTD, an entity it does not know, a comment, CDATA, mixed content, a mismatched close) refused with a reason that
// does not quote the document.

import { describe, expect, test } from 'bun:test'
import { parseXml, xmlChildren, XmlError, xmlOne, xmlOptional, xmlText } from '../aws/xml'

const DESCRIBE_STACKS = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeStacksResponse xmlns="http://cloudformation.amazonaws.com/doc/2010-05-15/">
  <DescribeStacksResult>
    <Stacks>
      <member>
        <StackName>fabrika-main-apps</StackName>
        <StackStatus>UPDATE_ROLLBACK_COMPLETE</StackStatus>
        <StackStatusReason>The following resource(s) failed to update: [Service].&#xD;&#xA;Retry &amp; check &lt;Service&gt;</StackStatusReason>
        <Outputs>
          <member><OutputKey>ClusterName</OutputKey><OutputValue>fabrika-apps</OutputValue></member>
          <member><OutputKey>Empty</OutputKey><OutputValue/></member>
        </Outputs>
      </member>
    </Stacks>
  </DescribeStacksResult>
  <ResponseMetadata><RequestId>5ccc7dcd-744c-11e5-be70-1b08c228efb3</RequestId></ResponseMetadata>
</DescribeStacksResponse>
`

/** The reason a document is refused with, or `null` when it is read. */
function refusal(document: string, limits?: Parameters<typeof parseXml>[1]): string | null {
	try {
		parseXml(document, limits)
		return null
	} catch (error) {
		if (!(error instanceof XmlError)) throw error
		return error.reason
	}
}

describe('parseXml', () => {
	test('reads an answer into elements, attributes and text, with references expanded', () => {
		const root = parseXml(DESCRIBE_STACKS)
		expect(root.name).toBe('DescribeStacksResponse')
		expect(root.attributes).toEqual({ xmlns: 'http://cloudformation.amazonaws.com/doc/2010-05-15/' })
		const stack = xmlOne(xmlOne(xmlOne(root, 'DescribeStacksResult'), 'Stacks'), 'member')
		expect(xmlText(stack, 'StackStatus')).toBe('UPDATE_ROLLBACK_COMPLETE')
		expect(xmlText(stack, 'StackStatusReason')).toBe('The following resource(s) failed to update: [Service].\r\nRetry & check <Service>')
		const outputs = xmlChildren(xmlOne(stack, 'Outputs'), 'member').map((member) => [xmlText(member, 'OutputKey'), xmlText(member, 'OutputValue')])
		expect(outputs).toEqual([['ClusterName', 'fabrika-apps'], ['Empty', '']])
		expect(xmlText(stack, 'Description')).toBeNull()
		expect(xmlText(xmlOne(root, 'ResponseMetadata'), 'RequestId')).toBe('5ccc7dcd-744c-11e5-be70-1b08c228efb3')
	})

	test('takes a document without a declaration, a byte order mark, single quotes and whitespace inside tags', () => {
		const root = parseXml(`﻿<A  b = 'x &quot;y&quot;' ><C >z</C ></A>`)
		expect(root).toEqual({ name: 'A', attributes: { b: 'x "y"' }, children: [{ name: 'C', attributes: {}, children: [], text: 'z' }], text: '' })
	})

	test('the lookups refuse what the answer does not hold exactly once', () => {
		const root = parseXml('<A><B>1</B><B>2</B><C><D/></C></A>')
		expect(xmlChildren(root, 'B').map((child) => child.text)).toEqual(['1', '2'])
		expect(() => xmlOptional(root, 'B')).toThrow(XmlError)
		expect(() => xmlOne(root, 'E')).toThrow(XmlError)
		expect(xmlOptional(root, 'E')).toBeNull()
		expect(() => xmlText(root, 'C')).toThrow(XmlError)
		// A lookup's reason quotes the caller's name only, never one the document wrote.
		expect(() => xmlOne(root, 'E')).toThrow('no "E"')
		expect(String((() => {
			try {
				return xmlOne(root, 'E')
			} catch (error) {
				return error
			}
		})())).not.toContain('"A"')
	})

	test('normalizes literal line ends, and tabs and line ends in an attribute, but not what a reference names', () => {
		const root = parseXml('<a x="1\r\n2\t3&#xA;4">l1\r\nl2\rl3&#xD;</a>')
		expect(root.attributes).toEqual({ x: '1 2 3\n4' })
		expect(root.text).toBe('l1\nl2\nl3\r')
	})

	test('an attribute named __proto__ is one like any other', () => {
		const root = parseXml('<a __proto__="x"/>')
		expect(Object.hasOwn(root.attributes, '__proto__')).toBe(true)
		expect(Object.entries(root.attributes)).toEqual([['__proto__', 'x']])
		expect(refusal('<a __proto__="x" __proto__="y"/>')).toBe('a duplicate attribute')
	})

	test('takes "]]&gt;" in text, the declaration with any case of UTF-8, and layout between children', () => {
		expect(parseXml('<a>]]&gt;</a>').text).toBe(']]>')
		expect(parseXml('<?xml version="1.0" encoding="utf-8"?><a/>').name).toBe('a')
		expect(parseXml('<a>\r\n\t <b/> </a>').children.length).toBe(1)
	})

	test('refuses every construct beyond elements, attributes and text', () => {
		const cases: readonly [string, string][] = [
			['<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>', 'a comment, CDATA, DTD or processing instruction'],
			['<?xml version="1.0"?><!DOCTYPE a><a/>', 'a comment, CDATA, DTD or processing instruction'],
			['<a>&x;</a>', 'an entity other than the five predefined'],
			['<a>&amp</a>', 'an unterminated reference'],
			['<a><!-- note --></a>', 'a comment, CDATA, DTD or processing instruction'],
			['<a><![CDATA[x]]></a>', 'a comment, CDATA, DTD or processing instruction'],
			['<a><?php x?></a>', 'a comment, CDATA, DTD or processing instruction'],
			['<?xml version="1.1"?><a/>', 'an XML declaration this reader does not take'],
			['<?xml version="1.0" encoding="UTF-16"?><a/>', 'an XML declaration this reader does not take'],
			['<a>text<b/></a>', 'text beside child elements'],
			['<a><b></a></b>', 'a close that does not match its element'],
			['<a x="1" x="2"/>', 'a duplicate attribute'],
			['<a x="1"y="2"/>', 'whitespace before an attribute was expected'],
			['<a x=1/>', 'a quoted attribute value was expected'],
			['<a x="<"/>', 'a raw "<" in text'],
			['<a/><b/>', 'content after the root element'],
			['<a>', 'the document ends inside an element'],
			// A namespace prefix on an element: AWS writes none.
			['<ns:a/>', 'a namespace prefix on an element'],
			['<a></ns:a>', 'a namespace prefix on an element'],
			// The predefined entities are five names, never a member of Object.prototype.
			['<a>&constructor;</a>', 'an entity other than the five predefined'],
			['<a>&toString;</a>', 'an entity other than the five predefined'],
			['<a>&valueOf;</a>', 'an entity other than the five predefined'],
			['<a>&__proto__;</a>', 'an entity other than the five predefined'],
			// Only space, tab, CR and LF are layout between children; a no-break space, raw or by reference, is text.
			['<a> <b/></a>', 'text beside child elements'],
			['<a>&#xA0;<b/></a>', 'text beside child elements'],
			['<a>x]]>y</a>', '"]]>" in text'],
			['<?xml VERSION="1.0"?><a/>', 'an XML declaration this reader does not take'],
			['<?xml version="1.0" standalone="YES"?><a/>', 'an XML declaration this reader does not take'],
			['<a>&#0;</a>', 'a reference to a character XML does not allow'],
			['<a>&#xD800;</a>', 'a reference to a character XML does not allow'],
			['<a>\u0001</a>', 'a character XML does not allow'],
			['text', 'an element was expected'],
		]
		for (const [document, reason] of cases) expect([document, refusal(document)]).toEqual([document, reason])
	})

	test('bounds the length, the depth and the element count', () => {
		expect(refusal('<a/>', { maxLength: 3 })).toBe('the document is too long')
		expect(refusal('<a><b><c/></b></a>', { maxDepth: 2 })).toBe('the document is nested too deep')
		expect(refusal('<a><b/><b/></a>', { maxElements: 2 })).toBe('the document has too many elements')
		// The defaults stop a deep document before the stack does, and a limit asked higher is held to its default.
		const deep = `${'<a>'.repeat(10_000)}${'</a>'.repeat(10_000)}`
		expect(refusal(deep)).toBe('the document is nested too deep')
		expect(refusal(deep, { maxDepth: 1_000_000 })).toBe('the document is nested too deep')
		expect(refusal(`<a>${'x'.repeat(2 * 1024 * 1024)}</a>`, { maxLength: 10 * 1024 * 1024 })).toBe('the document is too long')
	})

	test('a refusal names the problem and the offset, never the content', () => {
		const secret = 'sk_live_not_to_be_quoted'
		const failure = (() => {
			try {
				return parseXml(`<a><b>${secret}</b>&unknown;</a>`)
			} catch (error) {
				return error
			}
		})()
		expect(failure).toBeInstanceOf(XmlError)
		expect(String(failure)).not.toContain(secret)
		expect(String(failure)).not.toContain('unknown')
	})
})
