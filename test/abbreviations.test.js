const { test } = require('node:test');
const assert = require('node:assert/strict');
const { expandAbbreviations } = require('../src/abbreviations.js');
const { decodeGlyphs } = require('../src/math-speech.js');

// Every visible character gets its own 5pt-wide glyph box, left to right
function textNode(text, extra = {}) {
	let glyphCount = text.replace(/\s/g, '').length;
	let widths = Array.from({ length: glyphCount }, () => 5);
	let textMap = JSON.stringify([[0, 0, 100, 700, 100 + 5 * glyphCount, 710, ...widths]]);
	return { text, anchor: { textMap }, ...extra };
}

const doc = (...nodes) => ({ content: [{ type: 'paragraph', content: nodes }] });
const spoken = d => d.content[0].content.map(n => n.text).join('');

test('expands figure and section pointers so the sentence stays whole', () => {
	let d = doc(textNode('As shown in Fig. 4 and Sec. 2, the garden grew; see also Alg. 1 and Tab. 3.'));
	expandAbbreviations(d);
	assert.equal(spoken(d), 'As shown in Figure 4 and Section 2, the garden grew; see also Algorithm 1 and Table 3.');
});

test('expands Latin phrase abbreviations', () => {
	let d = doc(textNode('Small birds (e.g., wrens) visited less, i.e. rarely, cf. the summer counts vs. winter.'));
	expandAbbreviations(d);
	assert.equal(spoken(d), 'Small birds (for example, wrens) visited less, that is rarely, compare the summer counts versus winter.');
});

test('keeps the number after an equation pointer so it is spoken', () => {
	// Zotero skips bracket groups that are mostly links, which would drop the
	// "(3)" and leave "Equation" hanging
	let number = textNode('3', { refs: [[12]] });
	let d = doc(textNode('which follows from Eq. ('), number, textNode(') directly.'));
	expandAbbreviations(d);
	assert.equal(spoken(d), 'which follows from Equation (3) directly.');
	assert.equal(number.refs, undefined);
});

test('leaves figure links alone, since Zotero skips parenthesized figure pointers on purpose', () => {
	let number = textNode('2)', { refs: [[30]] });
	let d = doc(textNode('the counts dropped (Fig. '), number);
	expandAbbreviations(d);
	assert.equal(spoken(d), 'the counts dropped (Figure 2)');
	assert.deepEqual(number.refs, [[30]]);
});

test('ignores words that merely start like an abbreviation', () => {
	let d = doc(textNode('The Sector. Ecology. Prague. Figs grow here; the fig harvest ended.'));
	let before = JSON.stringify(d);
	assert.equal(expandAbbreviations(d), 0);
	assert.equal(JSON.stringify(d), before);
});

test('highlights the abbreviation while its expansion is spoken', () => {
	let node = textNode('Fig. 2');
	let original = decodeGlyphs(node.anchor.textMap).glyphs;
	expandAbbreviations(doc(node));
	assert.equal(node.text, 'Figure 2');

	// "Figure" covers the F, i and g glyphs; the period's glyph is unused;
	// the 2 still maps to its own glyph
	let glyphs = decodeGlyphs(node.anchor.textMap).glyphs.map(g => g.x1);
	let [f, i, g, , two] = original.map(o => o.x1);
	assert.deepEqual(glyphs, [f, f, i, i, g, g, two]);
});
