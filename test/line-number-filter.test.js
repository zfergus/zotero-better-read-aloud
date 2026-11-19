const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripLineNumbers } = require('../src/line-number-filter.js');

// Minimal SDT builders. Each body line becomes "<number> <text>" the way
// Zotero's extractor emits a line-numbered manuscript.
const LINES_PER_PAGE = 45;

function textNode(text, page = 0) {
	return { text, anchor: { textMap: JSON.stringify([[0, page, 50, 700, 280, 708, 3, 3, 3]]) } };
}

function numberedLines(lines, firstNumber, page) {
	let content = [];
	lines.forEach((line, i) => {
		content.push(textNode(String(firstNumber + i), page), { text: ' ' }, textNode(line, page));
	});
	return content;
}

function paragraph(content, page = 0, extra = {}) {
	return { type: 'paragraph', anchor: { pageRects: [[page, 50, 100, 280, 700]] }, content, ...extra };
}

function fillerLines(count) {
	return Array.from({ length: count }, (_, i) => `filler line ${i} of the body text and`);
}

// A document whose pages are full of line-numbered prose, with `lines`
// spliced in at the start of the first page
function manuscript(lines, pages = 3) {
	let content = [];
	let next = 1;
	for (let page = 0; page < pages; page++) {
		let pageLines = page === 0 ? [...lines, ...fillerLines(LINES_PER_PAGE - lines.length)] : fillerLines(LINES_PER_PAGE);
		content.push(paragraph(numberedLines(pageLines, next, page), page));
		next += pageLines.length;
	}
	return { content, catalog: { pages: Array.from({ length: pages }, () => ({})) } };
}

function blockText(block) {
	let text = '';
	let visit = nodes => nodes.forEach(n => {
		if (typeof n.text === 'string') text += n.text;
		if (Array.isArray(n.content)) visit(n.content);
	});
	visit(block.content);
	return text.replace(/\s+/g, ' ').trim();
}

test('removes line numbers that label every line of the body text', () => {
	let doc = manuscript(['The garden survey counted the', 'birds that visited each morning.']);
	stripLineNumbers(doc);
	let text = blockText(doc.content[0]);
	assert.ok(text.startsWith('The garden survey counted the birds that visited each morning.'));
	assert.doesNotMatch(doc.content.map(blockText).join(' '), /\b\d+\b(?! of)/);
});

test('leaves sparse numbered runs such as footnote markers untouched', () => {
	// Three markers per page over twelve pages: consecutive, but far too
	// sparse to be line numbers
	let content = [];
	for (let page = 0, n = 1; page < 12; page++) {
		let nodes = [];
		for (let k = 0; k < 3; k++, n++) {
			nodes.push(textNode(String(n), page), textNode(` Footnote text number ${n}.`, page));
		}
		content.push(paragraph(nodes, page));
	}
	let doc = { content, catalog: { pages: Array.from({ length: 12 }, () => ({})) } };
	let before = JSON.stringify(doc);
	assert.equal(stripLineNumbers(doc), 0);
	assert.equal(JSON.stringify(doc), before);
});

test('rejoins a word hyphenated across a line number', () => {
	let doc = manuscript(['which required a careful measure-', 'ment of every nest box.']);
	stripLineNumbers(doc);
	assert.match(blockText(doc.content[0]), /careful measurement of every/);

	// The hyphen glyph stays in the position map as a soft hyphen, so
	// highlighting still lines up with the page
	let hyphenNode = doc.content[0].content.find(n => n.text === 'which required a careful measure');
	assert.equal(JSON.parse(hyphenNode.anchor.textMap).at(-1)[0] & 1, 1);
});

test('keeps suspended hyphens such as "short- and long-term"', () => {
	let doc = manuscript(['we compared short-', 'and long-term counts.']);
	stripLineNumbers(doc);
	assert.match(blockText(doc.content[0]), /compared short- and long-term/);
});

test('turns lines misread as a numbered list back into one paragraph', () => {
	let doc = manuscript(['Opening paragraph line.']);
	let items = numberedLines(['Most visits happened before nine', 'and dropped off sharply after noon'], 1000, 0)
		.reduce((acc, node, i) => {
			if (i % 3 === 0) acc.push({ type: 'listitem', content: [] });
			acc.at(-1).content.push(node);
			return acc;
		}, []);
	// Continue the numbering so the list's numbers belong to the same run
	let last = doc.content.at(-1).content;
	let nextNumber = Number(last[last.length - 3].text) + 1;
	items.forEach((item, i) => { item.content[0].text = String(nextNumber + i); });
	doc.content.push({ type: 'list', anchor: { pageRects: [[2, 50, 100, 280, 700]] }, content: items });

	stripLineNumbers(doc);
	let repaired = doc.content.at(-1);
	assert.equal(repaired.type, 'paragraph');
	assert.equal(blockText(repaired), 'Most visits happened before nine and dropped off sharply after noon');
});

test('links the halves of a paragraph split across a column break', () => {
	let doc = manuscript(['the feeders were refilled every after-']);
	let lastPage = doc.content.at(-1).content;
	let next = Number(lastPage[lastPage.length - 3].text) + 1;
	// The first half ends the first page; a figure caption sits in between
	doc.content[0].content.splice(3); // keep only "1 the feeders were refilled every after-"
	doc.content.splice(1, 0,
		{ type: 'caption', flowClass: 'auxiliary', content: [{ text: 'Figure 2: Overview.' }] },
		paragraph(numberedLines(['noon. The counts continued through the', ...fillerLines(50)], 2, 0), 0));
	// Keep numbering consecutive for the remaining pages
	doc.content.slice(3).forEach(block => block.content.forEach((n, i) => {
		if (i % 3 === 0) n.text = String(next++ + 50);
	}));

	stripLineNumbers(doc);
	let [first, , second] = doc.content;
	assert.deepEqual(first.nextPart, [2]);
	assert.deepEqual(second.previousPart, [0]);
	assert.equal(blockText(first), 'the feeders were refilled every after');
});
