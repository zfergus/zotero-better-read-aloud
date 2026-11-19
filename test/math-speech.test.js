const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verbalizeMath, decodeGlyphs } = require('../src/math-speech.js');

// Every visible character gets its own 5pt-wide glyph box, laid out left to
// right, the way Zotero's extractor records text positions
function textNode(text, extra = {}) {
	let glyphCount = text.replace(/\s/g, '').length;
	let widths = Array.from({ length: glyphCount }, () => 5);
	let textMap = JSON.stringify([[0, 0, 100, 700, 100 + 5 * glyphCount, 710, ...widths]]);
	return { text, anchor: { textMap }, ...extra };
}

function doc(...blocks) {
	return { content: blocks, catalog: { pages: [{}] } };
}

const equation = (...nodes) => ({ type: 'math', content: nodes });
const paragraph = (...nodes) => ({ type: 'paragraph', content: nodes });
const spoken = block => block.content.map(n => n.text).join('').replace(/\s+/g, ' ').trim();

test('speaks Greek letters and operators in a display equation', () => {
	let d = doc(equation(textNode('E = '), textNode('α'), textNode(' ∑ x − β')));
	verbalizeMath(d);
	assert.equal(spoken(d.content[0]), 'E equals alpha sum of x minus beta');
});

test('reads superscripts as powers and subscripts as "sub"', () => {
	let d = doc(equation(
		textNode('v'), textNode('2', { style: { sup: true } }),
		textNode(' + w'), textNode('i', { style: { sub: true } }),
		textNode(' + A'), textNode('−1', { style: { sup: true } }),
	));
	verbalizeMath(d);
	assert.equal(spoken(d.content[0]), 'v squared plus w sub i plus A inverse');
});

test('reads the norm bars around a variable once', () => {
	let d = doc(equation(textNode('∥v∥ ≤ 1')));
	verbalizeMath(d);
	assert.equal(spoken(d.content[0]), 'norm of v less than or equal to 1');
});

test('separates inline math from the word it is glued to', () => {
	let d = doc(paragraph(textNode('the sample varianceσ grows')));
	verbalizeMath(d);
	assert.equal(spoken(d.content[0]), 'the sample variance sigma grows');
});

test('leaves footnote markers, ordinals and plain prose operators alone', () => {
	let d = doc(paragraph(
		textNode('as noted before'), textNode('3', { style: { sup: true } }),
		textNode(' on the 20'), textNode('th', { style: { sup: true } }),
		textNode(' day, in C++ and/or Java.'),
	));
	let before = JSON.stringify(d);
	assert.equal(verbalizeMath(d), 0);
	assert.equal(JSON.stringify(d), before);
});

test('leaves code listings untouched', () => {
	let d = doc(
		{ type: 'preformatted', content: [textNode('>>> x = y / 2')] },
		equation(textNode('a = b', { style: { monospace: true } })),
	);
	let before = JSON.stringify(d);
	verbalizeMath(d);
	assert.equal(JSON.stringify(d), before);
});

test('keeps highlighting on the original glyphs', () => {
	let node = textNode('kα + 1');
	let original = decodeGlyphs(node.anchor.textMap).glyphs;
	verbalizeMath(doc(equation(node)));
	assert.equal(node.text, 'k alpha plus 1');

	// Each visible character of the spoken text maps to the glyph it was
	// spoken for: k -> k, every letter of "alpha" -> α, and so on
	let glyphs = decodeGlyphs(node.anchor.textMap).glyphs;
	let source = { k: 0, alpha: 1, plus: 2, 1: 3 };
	let expected = [];
	for (let word of node.text.split(' ')) {
		for (let i = 0; i < word.length; i++) {
			expected.push(original[source[word]].x1);
		}
	}
	assert.deepEqual(glyphs.map(g => g.x1), expected);
});
