// Strips manuscript line numbers (the "lineno" margin counters in review
// copies) from a structured document text (SDT) tree before Read Aloud sees it.
//
// We can't rely on position alone because the PDF extractor folds the margin
// numbers into the neighboring paragraph as their own text nodes, and the
// coordinates vary by template. Instead we use the one property every
// line-numbered manuscript shares: the numbers form long, nearly consecutive
// runs (1, 2, 3, ...) in reading order. Ordinary digits in prose, such as
// superscripts or figure numbers, almost never line up into a run like that.

const DIGIT_NODE_RE = /^\s*\d{1,4}\s*$/;
// Each step in a run may skip a few numbers, because some line numbers land
// inside figures, tables, or merged text nodes that we never see here
const MAX_STEP = 3;
// How far back we look for the previous member of a run. Numbers that are
// close in value are always close in reading order, so this keeps the search
// linear-ish without missing real runs.
const LOOKBACK = 60;
// Runs shorter than this are left alone. Algorithm listings and enumerated
// steps produce short runs, and we would rather read a few stray numbers than
// silently drop real content.
const MIN_RUN_LENGTH = 20;
// Numbered footnotes, reference lists, and tables of contents also form
// consecutive runs, but only a handful per page. Line numbers label every line,
// so a real run has dozens per page. Testing showed line-numbered papers at
// 50-60 per page and everything else at 20 or fewer, so 30 sits safely between.
const MIN_NUMBERS_PER_PAGE = 30;

function collectDigitNodes(nodes, out, page) {
	if (!Array.isArray(nodes)) {
		return;
	}
	for (let node of nodes) {
		if (!node || typeof node !== 'object') {
			continue;
		}
		if (typeof node.text === 'string' && DIGIT_NODE_RE.test(node.text)) {
			out.push({ value: parseInt(node.text, 10), node, page });
		}
		if (Array.isArray(node.content)) {
			collectDigitNodes(node.content, out, page);
		}
	}
}

// Find the longest chain (in document order) where each value is 1..MAX_STEP
// larger than the previous one, ignoring nodes already claimed by a run.
function findLongestRun(candidates, claimed) {
	let length = new Array(candidates.length).fill(0);
	let prev = new Array(candidates.length).fill(-1);
	let bestEnd = -1;
	for (let i = 0; i < candidates.length; i++) {
		if (claimed.has(i)) {
			continue;
		}
		length[i] = 1;
		for (let k = Math.max(0, i - LOOKBACK); k < i; k++) {
			if (claimed.has(k)) {
				continue;
			}
			let step = candidates[i].value - candidates[k].value;
			if (step >= 1 && step <= MAX_STEP && length[k] + 1 > length[i]) {
				length[i] = length[k] + 1;
				prev[i] = k;
			}
		}
		if (bestEnd === -1 || length[i] > length[bestEnd]) {
			bestEnd = i;
		}
	}
	let run = [];
	for (let i = bestEnd; i !== -1; i = prev[i]) {
		run.push(i);
	}
	return run;
}

/**
 * Blank out line-number text nodes in place. Returns how many were removed.
 *
 * We replace each number with a single space instead of deleting the node.
 * That keeps sibling indexes stable (SDT positions are index paths), and the
 * reader treats whitespace-only nodes as word separators without anchoring
 * anything to them.
 */
function stripLineNumbers(structure) {
	let candidates = [];
	for (let block of structure?.content || []) {
		let page = block?.anchor?.pageRects?.[0]?.[0];
		collectDigitNodes(block?.content, candidates, page);
	}

	// Every run we look at is marked as seen, but only dense runs get removed
	let seen = new Set();
	let lineNumbers = [];
	for (;;) {
		let run = findLongestRun(candidates, seen);
		if (run.length < MIN_RUN_LENGTH) {
			break;
		}
		for (let i of run) {
			seen.add(i);
		}
		let pages = new Set(run.map(i => candidates[i].page)).size || 1;
		if (run.length / pages >= MIN_NUMBERS_PER_PAGE) {
			lineNumbers.push(...run);
		}
	}

	let lineNumberNodes = new Set();
	for (let i of lineNumbers) {
		let node = candidates[i].node;
		lineNumberNodes.add(node);
		node.text = ' ';
		delete node.anchor;
		delete node.style;
	}
	if (lineNumberNodes.size) {
		structure.content = structure.content.map(block => repairFakeList(block, lineNumberNodes));
		joinHyphenatedLines(structure, lineNumberNodes);
		linkSplitParagraphs(structure);
	}
	return lineNumberNodes.size;
}

// The extractor sees "12 The survey found that..." and decides each line is
// an item of a numbered list. Read Aloud then treats every line as its own
// paragraph, so it pauses after each line and can't stitch hyphenated words
// back together. We undo that by turning such lists back into a paragraph.
const FAKE_LIST_ITEM_RATIO = 0.6;

function firstTextNode(item) {
	for (let node of item?.content || []) {
		if (typeof node?.text === 'string') {
			if (node.text.trim() || /* a blanked line number */ node.anchor === undefined) {
				return node;
			}
		}
	}
	return null;
}

function repairFakeList(block, lineNumberNodes) {
	if (block?.type !== 'list' || !Array.isArray(block.content) || !block.content.length) {
		return block;
	}
	let items = block.content;
	// We only flatten items that hold inline text. Items with nested blocks
	// are real structure, and flattening them would mix incompatible node types.
	if (items.some(item => item?.type !== 'listitem'
			|| (item.content || []).some(node => typeof node?.text !== 'string'))) {
		return block;
	}
	let numbered = items.filter(item => lineNumberNodes.has(firstTextNode(item))).length;
	if (numbered / items.length < FAKE_LIST_ITEM_RATIO) {
		return block;
	}
	let content = [];
	for (let item of items) {
		if (content.length) {
			content.push({ text: ' ' });
		}
		content.push(...item.content);
	}
	let paragraph = { type: 'paragraph', content };
	for (let key of ['anchor', 'flowClass']) {
		if (block[key] !== undefined) {
			paragraph[key] = block[key];
		}
	}
	return paragraph;
}

// Hyphenated line breaks
//
// When a word is split across lines ("measure-" / "ment"), Zotero's extractor
// normally marks that hyphen as a "soft hyphen": the glyph stays in the
// position map so highlighting lines up, but it is left out of the text. A
// line number sitting between the two halves hides the line break from the
// extractor, so the hyphen survives and Read Aloud says "measure ment". We
// redo that soft-hyphen step ourselves wherever a line number was removed.

// The same hyphen characters Zotero's extractor treats as line-break hyphens
const LINE_BREAK_HYPHEN_RE = /[\u002D\u058A\u1400\u1806\u2010\u2E17\u2E1A\u30A0\uFE63\uFF0D]$/u;
// Header bit Zotero uses on a text-map run whose last glyph is a soft hyphen
const SOFT_HYPHEN_FLAG = 1;
// A hyphen followed by one of these is a suspended compound ("short- and
// long-term studies"), so we keep it instead of gluing the words together
const SUSPENDED_HYPHEN_NEXT_WORDS = new Set(['and', 'or', 'nor', 'to']);

// True when Zotero already dropped this node's trailing hyphen as a soft
// hyphen. The word is still split, though, because the blanked line number
// between the halves reads as a space.
function endsWithSoftHyphen(node) {
	let textMap = node?.anchor?.textMap;
	if (typeof textMap !== 'string') {
		return false;
	}
	try {
		let runs = JSON.parse(textMap);
		let lastRun = runs[runs.length - 1];
		return Array.isArray(lastRun) && (lastRun[0] & SOFT_HYPHEN_FLAG) !== 0;
	}
	catch (e) {
		return false;
	}
}

function isWhitespaceNode(node) {
	return typeof node?.text === 'string' && !/\S/.test(node.text);
}

function startsLowercaseContinuation(text) {
	if (!/^\p{Ll}/u.test(text || '')) {
		return false;
	}
	let firstWord = text.match(/^\p{L}+/u)[0];
	return !SUSPENDED_HYPHEN_NEXT_WORDS.has(firstWord);
}

/**
 * Drop a trailing line-break hyphen from a text node the way Zotero does: the
 * character leaves the text, and the last text-map run is flagged so the
 * hyphen's glyph position is ignored. Returns false if the text map doesn't
 * look like we expect, in which case we leave the node alone.
 */
function makeTrailingSoftHyphen(node) {
	if (!LINE_BREAK_HYPHEN_RE.test(node.text)) {
		return false;
	}
	let textMap = node.anchor?.textMap;
	if (typeof textMap === 'string') {
		let runs;
		try {
			runs = JSON.parse(textMap);
		}
		catch (e) {
			return false;
		}
		let lastRun = Array.isArray(runs) ? runs[runs.length - 1] : null;
		if (!Array.isArray(lastRun) || lastRun.length < 6 || !Number.isInteger(lastRun[0])
				|| (lastRun[0] & SOFT_HYPHEN_FLAG)) {
			return false;
		}
		lastRun[0] |= SOFT_HYPHEN_FLAG;
		node.anchor.textMap = JSON.stringify(runs);
	}
	node.text = node.text.slice(0, -1);
	return true;
}

// Join hyphenated words inside a single paragraph, across a removed number
function joinHyphenatedLines(structure, lineNumberNodes) {
	let visit = (nodes) => {
		if (!Array.isArray(nodes)) {
			return;
		}
		for (let i = 0; i < nodes.length; i++) {
			let node = nodes[i];
			if (Array.isArray(node?.content)) {
				visit(node.content);
				continue;
			}
			if (typeof node?.text !== 'string') {
				continue;
			}
			let alreadySoft = endsWithSoftHyphen(node);
			if (!alreadySoft && !LINE_BREAK_HYPHEN_RE.test(node.text)) {
				continue;
			}
			let j = i + 1;
			let crossesLineNumber = false;
			while (j < nodes.length && isWhitespaceNode(nodes[j])) {
				crossesLineNumber ||= lineNumberNodes.has(nodes[j]);
				j++;
			}
			if (!crossesLineNumber || !/^\p{Ll}/u.test(nodes[j]?.text || '')) {
				continue;
			}
			if (!alreadySoft && !startsLowercaseContinuation(nodes[j].text)) {
				continue;
			}
			if (alreadySoft || makeTrailingSoftHyphen(node)) {
				// The whitespace between the halves would split the word again.
				// We empty these nodes rather than removing them so that the
				// node indexes other parts of the document refer to stay valid.
				for (let k = i + 1; k < j; k++) {
					nodes[k].text = '';
				}
			}
		}
	};
	for (let block of structure.content) {
		visit(block?.content);
	}
}

// Paragraphs split across columns or pages
//
// Zotero normally links the halves of a paragraph that continues in the next
// column ("parts"), and Read Aloud reads them as one, dropping the hyphen in
// "after-" / "noon". Line numbers break the checks it uses to find those
// halves, so in a line-numbered paper nothing gets linked. We relink them with
// a simpler text-only rule: the first half doesn't end a sentence and the
// second half starts with a lowercase letter.

function getEdgeTextNodes(block, fromEnd) {
	let out = [];
	let visit = (nodes) => {
		if (!Array.isArray(nodes)) {
			return;
		}
		let ordered = fromEnd ? [...nodes].reverse() : nodes;
		for (let node of ordered) {
			if (Array.isArray(node?.content)) {
				visit(node.content);
			}
			else if (typeof node?.text === 'string') {
				out.push(node);
			}
		}
	};
	visit(block?.content);
	// Leading whitespace nodes, then the first node with visible text
	let edge = [];
	for (let node of out) {
		edge.push(node);
		if (/\S/.test(node.text)) {
			break;
		}
	}
	return edge;
}

function linkSplitParagraphs(structure) {
	let content = structure.content;
	let previous = null;
	for (let i = 0; i < content.length; i++) {
		let block = content[i];
		// Figures, captions, headers and footers sit between the halves of a
		// split paragraph, so we look past them. Any other body block, like a
		// heading or an equation, ends the paragraph for good.
		if (!block || block.flowClass) {
			continue;
		}
		if (block.type !== 'paragraph') {
			previous = null;
			continue;
		}
		if (previous && !previous.block.nextPart && !block.previousPart) {
			tryLinkParts(previous, { index: i, block });
		}
		previous = { index: i, block };
	}
}

function tryLinkParts(first, second) {
	let tail = getEdgeTextNodes(first.block, true);
	let head = getEdgeTextNodes(second.block, false);
	let lastNode = tail[tail.length - 1];
	let firstNode = head[head.length - 1];
	if (!lastNode || !firstNode || !/\S/.test(lastNode.text) || !/\S/.test(firstNode.text)) {
		return;
	}
	let lastText = lastNode.text.trimEnd();
	let firstText = firstNode.text.trimStart();
	if (!/^\p{Ll}/u.test(firstText)) {
		return;
	}

	if (endsWithSoftHyphen(lastNode) && lastText === lastNode.text) {
		for (let node of [...tail.slice(0, -1), ...head.slice(0, -1)]) {
			node.text = '';
		}
	}
	else if (LINE_BREAK_HYPHEN_RE.test(lastText)) {
		if (!startsLowercaseContinuation(firstText) || lastText !== lastNode.text
				|| firstText !== firstNode.text || !makeTrailingSoftHyphen(lastNode)) {
			return;
		}
		// As inside a paragraph, emptying the whitespace around the boundary
		// lets Read Aloud glue the two halves into one word
		for (let node of [...tail.slice(0, -1), ...head.slice(0, -1)]) {
			node.text = '';
		}
	}
	else if (!/[\p{Ll}\p{Nd},;:]$/u.test(lastText)) {
		return;
	}

	first.block.nextPart = [second.index];
	second.block.previousPart = [first.index];
}

if (typeof module !== 'undefined') {
	module.exports = { stripLineNumbers };
}
