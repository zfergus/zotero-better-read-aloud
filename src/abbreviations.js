// Expands academic abbreviations ("Fig.", "Eq.", "Sec.") into full words.
//
// Abbreviations cause two problems in Read Aloud. Voices pronounce them
// literally ("fig", "eek"), and Zotero's sentence splitter treats the period
// as the end of a sentence, so Read Aloud stops and pauses in the middle of
// "as shown in Eq. 4". Writing out "Equation" fixes both.
//
// As with math, we rebuild each node's text map so every letter of the
// expansion points at the abbreviation's glyphs, and highlighting stays put.

var Abbreviations = (function (MathSpeech) {
	// Pointers to parts of the paper. We only expand these when a number,
	// bracket or line end follows, which is how they appear in running text.
	const POINTERS = {
		Fig: 'Figure', Figs: 'Figures', Eq: 'Equation', Eqs: 'Equations', Eqn: 'Equation',
		Eqns: 'Equations', Sec: 'Section', Secs: 'Sections', Sect: 'Section', Alg: 'Algorithm',
		Algs: 'Algorithms', Tab: 'Table', Tabs: 'Tables', Tbl: 'Table', Thm: 'Theorem',
		Thms: 'Theorems', Def: 'Definition', Lem: 'Lemma', Prop: 'Proposition', Cor: 'Corollary',
		App: 'Appendix', Appx: 'Appendix', Ch: 'Chapter', Chap: 'Chapter', Ref: 'Reference',
		Refs: 'References', Ex: 'Example', Suppl: 'Supplemental',
	};

	// Latin and other phrase abbreviations, expanded wherever they appear.
	// "et al." and "etc." are left alone: voices say them well, and Zotero's
	// splitter already knows not to end a sentence on them.
	const PHRASES = {
		'e.g.': 'for example', 'i.e.': 'that is', 'cf.': 'compare', 'vs.': 'versus',
		'w.r.t.': 'with respect to', 'resp.': 'respectively', 'approx.': 'approximately',
	};

	const EQUATION_WORDS = new Set(['Eq', 'Eqs', 'Eqn', 'Eqns']);

	function escape(text) {
		return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	const pointerKeys = Object.keys(POINTERS).sort((a, b) => b.length - a.length);
	// A pointer abbreviation is its own word, capitalized or not, and is
	// followed by a space, a digit, a bracket, a tilde, or the end of the node
	// (the number often sits in the next, linked node)
	const POINTER_RE = new RegExp(
		'(?<![\\p{L}\\p{N}])(' + pointerKeys.map(escape).join('|') + ')\\.(?=[\\s\\d(\\[~]|$)',
		'giu'
	);
	const PHRASE_RE = new RegExp(
		'(?<![\\p{L}\\p{N}.])(' + Object.keys(PHRASES).map(escape).join('|') + ')(?=[\\s,;:)\\]]|$)',
		'giu'
	);

	function matchCase(abbreviation, expansion) {
		return /^\p{Lu}/u.test(abbreviation) ? expansion : expansion.toLowerCase();
	}

	function lookupPointer(abbreviation) {
		let key = pointerKeys.find(k => k.toLowerCase() === abbreviation.toLowerCase());
		return key ? { key, word: matchCase(abbreviation, POINTERS[key]) } : null;
	}

	/**
	 * Find every abbreviation in a text and return spoken pieces for
	 * MathSpeech.rewriteNode(): untouched characters map to themselves, and
	 * each letter of an expansion maps onto the abbreviation's letters.
	 */
	function expandText(text) {
		let matches = [];
		for (let m of text.matchAll(POINTER_RE)) {
			let found = lookupPointer(m[1]);
			if (found) {
				matches.push({ start: m.index, end: m.index + m[0].length, word: found.word, key: found.key });
			}
		}
		for (let m of text.matchAll(PHRASE_RE)) {
			let word = PHRASES[m[1].toLowerCase()];
			if (word) {
				matches.push({ start: m.index, end: m.index + m[0].length, word, key: null });
			}
		}
		if (!matches.length) {
			return null;
		}
		matches.sort((a, b) => a.start - b.start);

		let pieces = [];
		let cursor = 0;
		for (let match of matches) {
			if (match.start < cursor) {
				continue;
			}
			for (let i = cursor; i < match.start; i++) {
				pieces.push({ text: text[i], src: i });
			}
			// Spread the expansion over the abbreviation's letters, skipping
			// its periods, so the highlight covers exactly what was written
			let letters = [];
			for (let i = match.start; i < match.end; i++) {
				if (text[i] !== '.') {
					letters.push(i);
				}
			}
			[...match.word].forEach((ch, k) => {
				let src = ch === ' ' ? null : letters[Math.min(letters.length - 1, Math.floor(k * letters.length / match.word.length))];
				pieces.push({ text: ch, src });
			});
			cursor = match.end;
		}
		for (let i = cursor; i < text.length; i++) {
			pieces.push({ text: text[i], src: i });
		}
		return { pieces, equation: matches.some(m => EQUATION_WORDS.has(m.key)) };
	}

	// Zotero skips bracketed groups that are mostly links, which is how it
	// avoids reading "(Fig. 3)" pointers aloud. It also catches the number in
	// "Equation (4)", leaving "Equation" hanging, so we unlink the equation
	// numbers that follow an expanded "Eq." and Read Aloud speaks them. The
	// only cost is that those numbers aren't clickable in Zotero's reflowed
	// text view; links on the PDF page itself come from the PDF and still work.
	const NUMBER_NODE_RE = /^[\s(]*\d+(\.\d+)*[a-z]?[)\s.,;:]*$/;
	const CONNECTOR_RE = /^[\s(),;–-]*(and|or|to|through)?[\s(),;–-]*$/;

	function keepEquationNumbers(nodes, from) {
		for (let j = from; j < nodes.length && j < from + 8; j++) {
			let node = nodes[j];
			if (typeof node?.text !== 'string') {
				break;
			}
			if (node.refs && node.refs.length && NUMBER_NODE_RE.test(node.text)) {
				delete node.refs;
			}
			else if (!CONNECTOR_RE.test(node.text)) {
				break;
			}
		}
	}

	function visit(nodes, counter) {
		if (!Array.isArray(nodes)) {
			return;
		}
		for (let i = 0; i < nodes.length; i++) {
			let node = nodes[i];
			if (Array.isArray(node?.content)) {
				visit(node.content, counter);
				continue;
			}
			// Linked text (like a citation) is left exactly as written. We do
			// expand inside monospace text, because algorithm listings use it
			// for comments like "// see Eq. 4", and code rarely has a word,
			// a period and then a number or space.
			if (typeof node?.text !== 'string' || node.refs?.length) {
				continue;
			}
			let expanded = expandText(node.text);
			if (!expanded) {
				continue;
			}
			if (MathSpeech.rewriteNode(node, expanded.pieces)) {
				counter.nodes++;
			}
			if (expanded.equation) {
				keepEquationNumbers(nodes, i + 1);
			}
		}
	}

	/**
	 * Expand abbreviations in place. Returns how many text nodes changed.
	 */
	function expandAbbreviations(structure) {
		let counter = { nodes: 0 };
		for (let block of structure?.content || []) {
			if (!block || block.flowClass === 'excluded' || !Array.isArray(block.content)) {
				continue;
			}
			// Math blocks often swallow the sentence around an equation
			// ("..., which Eq. (3) shows"), so we include them
			if (['table', 'image', 'preformatted'].includes(block.type)) {
				continue;
			}
			visit(block.content, counter);
		}
		return counter.nodes;
	}

	return { expandAbbreviations };
})(typeof MathSpeech !== 'undefined' ? MathSpeech : require('./math-speech.js'));

if (typeof module !== 'undefined') {
	module.exports = Abbreviations;
}
