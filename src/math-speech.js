// Speaks math in words for Read Aloud.
//
// Zotero's PDF text keeps math as raw characters, so a voice reads "ω" as
// nothing, "∑" as silence, and "x" followed by a superscript "2" as "x 2".
// We rewrite those characters into words ("psi", "sum", "F squared").
//
// The catch is highlighting. Each text node carries a text map that ties every
// visible character to a glyph box on the page, and the reader walks the two
// in lockstep. If we only changed the text, every highlight after the first
// rewritten symbol would drift. Instead we rebuild the text map so that every
// letter of a spoken word points at the glyph it came from. Saying "alpha"
// then highlights the "α" on the page, and everything after it stays aligned.
//
// We can't recover structure the PDF text doesn't have. Fractions, roots and
// matrices arrive flattened ("1 2" for one half), so complex equations are
// still read as a best-effort sequence of terms.

var MathSpeech = (function () {
	const GREEK = {
		'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'epsilon', 'ϵ': 'epsilon',
		'ζ': 'zeta', 'η': 'eta', 'θ': 'theta', 'ϑ': 'theta', 'ι': 'iota', 'κ': 'kappa',
		'λ': 'lambda', 'μ': 'mu', 'ν': 'nu', 'ξ': 'xi', 'ο': 'omicron', 'π': 'pi', 'ϖ': 'pi',
		'ρ': 'rho', 'ϱ': 'rho', 'σ': 'sigma', 'ς': 'sigma', 'τ': 'tau', 'υ': 'upsilon',
		'φ': 'phi', 'ϕ': 'phi', 'χ': 'chi', 'ψ': 'psi', 'ω': 'omega',
		'Γ': 'capital gamma', 'Δ': 'capital delta', '∆': 'capital delta', 'Θ': 'capital theta',
		'Λ': 'capital lambda', 'Ξ': 'capital xi', 'Π': 'capital pi', 'Σ': 'capital sigma',
		'Υ': 'capital upsilon', 'Φ': 'capital phi', 'Ψ': 'capital psi', 'Ω': 'capital omega',
	};

	// Symbols that read the same wherever they appear
	const SYMBOLS = {
		'−': 'minus', '±': 'plus or minus', '∓': 'minus or plus', '×': 'times', '·': 'times',
		'÷': 'divided by', '≠': 'not equal to', '≈': 'approximately equals', '≃': 'approximately equals',
		'≡': 'is equivalent to', '∼': 'is on the order of', '∝': 'is proportional to',
		'≤': 'less than or equal to', '≥': 'greater than or equal to', '≪': 'much less than',
		'≫': 'much greater than', '∈': 'in', '∉': 'not in', '⊂': 'subset of', '⊆': 'subset of',
		'⊃': 'superset of', '∪': 'union', '∩': 'intersection', '⋂': 'intersection', '⋃': 'union',
		'∅': 'empty set', '∀': 'for all', '∃': 'there exists', '¬': 'not', '∧': 'and', '∨': 'or',
		'→': 'to', '↦': 'maps to', '←': 'gets', '⇒': 'implies', '⇔': 'if and only if',
		'∑': 'sum of', '∏': 'product of', '∫': 'integral of', '∮': 'contour integral of',
		'∂': 'partial', '∇': 'nabla', '∞': 'infinity', '√': 'square root of', '∘': 'composed with',
		'⊗': 'tensor', '⊕': 'direct sum', '⊤': 'transpose', '⊥': 'perpendicular to',
		'′': 'prime', '″': 'double prime', '°': 'degrees', 'ℝ': 'R', 'ℕ': 'N', 'ℤ': 'Z',
		'ℂ': 'C', 'ℓ': 'ell', '∠': 'angle', '⌊': 'floor of', '⌈': 'ceiling of',
	};

	// ASCII operators would be too noisy in ordinary prose ("C++", "and/or"),
	// so we only speak these inside text that is clearly math
	const MATH_ONLY_SYMBOLS = {
		'=': 'equals', '+': 'plus', '<': 'less than', '>': 'greater than', '/': 'over',
		'∗': 'star', '*': 'star', '^': 'to the',
	};

	// Accents on a single-letter variable. Accents inside ordinary words, like
	// the é in "café", stay as they are.
	const ACCENTS = {
		'̂': 'hat', 'ˆ': 'hat', '̃': 'tilde', '˜': 'tilde',
		'̄': 'bar', '¯': 'bar', '̅': 'bar', '̇': 'dot', '˙': 'dot',
		'̈': 'double dot', '¨': 'double dot', '̌': 'check', 'ˇ': 'check',
		'⃗': 'vector',
	};

	const SUPERSCRIPT_WORDS = {
		'2': 'squared', '3': 'cubed', '−1': 'inverse', '-1': 'inverse', '⊤': 'transpose',
		'T': 'transpose', '′': 'prime', '∗': 'star', '*': 'star', '+': 'plus', '−': 'minus',
		'◦': 'degrees', '∘': 'degrees', '°': 'degrees',
	};

	// Inside a sub- or superscript these are labels, not operators: a
	// superscript ∥ means "parallel component", not the start of a norm
	const SCRIPT_SYMBOL_WORDS = { '∥': 'parallel', '⊥': 'perpendicular', '×': 'by' };

	// Characters we drop entirely: variation selectors and stray combining
	// marks used to build large brackets, which a voice can't say anyway
	const SILENT_RE = /[︀-️⃒⃓]/;
	const MATH_CHAR_RE = new RegExp('[' + Object.keys(GREEK).concat(Object.keys(SYMBOLS), ['∥', '∗']).join('') + ']');
	const NO_SPACE_BEFORE_RE = /[\s,.;:!?)\]}]/;

	// Text-map decoding, mirroring structured-document-text's decoder so that
	// our idea of "which glyph belongs to which character" matches the reader's
	const SOFT_HYPHEN_FLAG = 1;
	const AXIS_DIR_SHIFT = 1;

	function decodeGlyphs(textMap) {
		let runs;
		try {
			runs = JSON.parse(textMap);
		}
		catch (e) {
			return null;
		}
		if (!Array.isArray(runs)) {
			return null;
		}
		let glyphs = [];
		let softHyphen = null;
		runs.forEach((run, runIndex) => {
			if (!Array.isArray(run) || run.length < 6) {
				return;
			}
			let [header, , minX, minY, maxX, maxY, ...widths] = run;
			let axisDir = (header >> AXIS_DIR_SHIFT) & 0b11;
			let vertical = axisDir === 1 || axisDir === 3;
			let start = vertical ? minY : minX;
			let end = vertical ? maxY : maxX;
			let positions = [];
			if (!widths.length) {
				positions.push({ x1: start, x2: end });
			}
			else {
				let pos = start;
				for (let w of widths) {
					let [delta, width] = Array.isArray(w) ? w : [0, w];
					pos += delta;
					positions.push({ x1: pos, x2: pos + width });
					pos += width;
				}
			}
			if (header & SOFT_HYPHEN_FLAG) {
				softHyphen = { runIndex, ...positions.pop() };
			}
			for (let p of positions) {
				glyphs.push({ runIndex, ...p });
			}
		});
		return { runs, glyphs, softHyphen };
	}

	const round = value => Math.round(value * 100) / 100;

	// Encode glyph positions back into runs. We always write explicit
	// [delta, width] pairs because rewritten text can revisit a glyph (every
	// letter of "alpha" points at the same α), which needs negative deltas.
	function encodeGlyphs(decoded, glyphs) {
		let out = [];
		let current = null;
		let cursor = 0;
		let push = (glyph) => {
			if (!current || current.runIndex !== glyph.runIndex) {
				let source = decoded.runs[glyph.runIndex];
				let header = source[0] & ~SOFT_HYPHEN_FLAG;
				let axisDir = (header >> AXIS_DIR_SHIFT) & 0b11;
				let vertical = axisDir === 1 || axisDir === 3;
				current = { runIndex: glyph.runIndex, run: [header, ...source.slice(1, 6)] };
				cursor = vertical ? source[3] : source[2];
				out.push(current);
			}
			let delta = round(glyph.x1 - cursor);
			let width = round(glyph.x2 - glyph.x1);
			current.run.push([delta, width]);
			cursor = cursor + delta + width;
		};
		glyphs.forEach(push);
		if (decoded.softHyphen) {
			push(decoded.softHyphen);
			current.run[0] |= SOFT_HYPHEN_FLAG;
		}
		return JSON.stringify(out.map(entry => entry.run));
	}

	/**
	 * Replace a node's text with spoken pieces. Each piece names the index of
	 * the source character it came from, so we can point its glyphs at the
	 * same spot on the page.
	 */
	function rewriteNode(node, pieces) {
		let text = pieces.map(piece => piece.text).join('');
		if (text === node.text) {
			return false;
		}
		let textMap = node.anchor?.textMap;
		let decoded = typeof textMap === 'string' ? decodeGlyphs(textMap) : null;
		if (decoded && decoded.glyphs.length) {
			// The reader assigns glyphs to non-whitespace characters in order
			let glyphOfChar = new Map();
			let next = 0;
			for (let i = 0; i < node.text.length && next < decoded.glyphs.length; i++) {
				if (!/\s/.test(node.text[i])) {
					glyphOfChar.set(i, decoded.glyphs[next++]);
				}
			}
			let glyphs = [];
			let last = decoded.glyphs[0];
			for (let piece of pieces) {
				let glyph = glyphOfChar.get(piece.src) || last;
				for (let ch of piece.text.split('')) {
					if (!/\s/.test(ch)) {
						glyphs.push(glyph);
					}
				}
				last = glyph;
			}
			node.anchor.textMap = encodeGlyphs(decoded, glyphs);
		}
		node.text = text;
		return true;
	}

	// Builds the spoken pieces for one node, keeping words apart with spaces
	class Speaker {
		// `before` is the text of the preceding node, which matters when an
		// accent arrives in a node of its own right after its variable
		constructor(before = '') {
			this.pieces = [];
			this.wantSpace = false;
			this.before = before;
		}

		get output() {
			return this.pieces.map(piece => piece.text).join('');
		}

		word(text, src) {
			if (!text) {
				this.wantSpace = true;
				return;
			}
			let output = this.output;
			if (output && !/\s$/.test(output)) {
				this.pieces.push({ text: ' ', src: null });
			}
			this.pieces.push({ text, src });
			this.wantSpace = true;
		}

		char(ch, src) {
			if (this.wantSpace && !NO_SPACE_BEFORE_RE.test(ch) && !/\s$/.test(this.output)) {
				this.pieces.push({ text: ' ', src: null });
			}
			this.wantSpace = false;
			this.pieces.push({ text: ch, src });
		}

		// True when the output ends in a lone letter, such as the "x" in "2 x",
		// which is how variables appear once math is flattened into text
		endsWithSingleLetter() {
			let output = this.output.trimEnd();
			return endsWithVariable(output || this.before);
		}
	}

	function endsWithVariable(text) {
		return /(^|[^\p{L}])\p{L}$/u.test(text.trimEnd());
	}

	function speakText(text, ctx, inMath, speaker = new Speaker(), offset = 0, inScript = false) {
		for (let i = 0; i < text.length; i++) {
			let ch = text[i];
			let src = offset + i;
			if (SILENT_RE.test(ch)) {
				continue;
			}
			if (inScript && SCRIPT_SYMBOL_WORDS[ch]) {
				speaker.word(SCRIPT_SYMBOL_WORDS[ch], src);
			}
			else if (ch === '∥') {
				// Norm bars come in pairs; we speak the opening one only
				ctx.normOpen = !ctx.normOpen;
				speaker.word(ctx.normOpen ? 'norm of' : '', src);
			}
			else if (ACCENTS[ch] && speaker.endsWithSingleLetter()) {
				speaker.word(ACCENTS[ch], src);
			}
			else if (GREEK[ch]) {
				speaker.word(GREEK[ch], src);
			}
			else if (SYMBOLS[ch]) {
				speaker.word(SYMBOLS[ch], src);
			}
			else if (inMath && MATH_ONLY_SYMBOLS[ch]
					// "//" starts a comment in algorithm listings, not a fraction
					&& !(ch === '/' && (text[i - 1] === '/' || text[i + 1] === '/'))) {
				speaker.word(MATH_ONLY_SYMBOLS[ch], src);
			}
			else {
				speaker.char(ch, src);
			}
		}
		return speaker;
	}

	// A superscript or subscript only means math when it hangs off a variable,
	// a symbol or a bracket. After an ordinary word it's a footnote marker, and
	// Zotero already handles linked markers itself.
	function attachesToMath(prevText) {
		let trimmed = prevText.replace(/\s+$/, '');
		if (!trimmed) {
			return false;
		}
		let last = trimmed[trimmed.length - 1];
		return /[)\]}|∥′\p{N}]/u.test(last)
			|| MATH_CHAR_RE.test(last)
			|| /(^|[^\p{L}])\p{L}$/u.test(trimmed);
	}

	function speakScript(node, ctx, prevText) {
		let raw = node.text;
		let trimmed = raw.trim();
		let first = raw.search(/\S/);
		let speaker = new Speaker();
		speaker.pieces.push({ text: ' ', src: null });
		let special = SUPERSCRIPT_WORDS[trimmed];
		// Spaces like ℝⁿ or Rᵐˣⁿ are read "R n" and "R m by n". A plain R with
		// a lone exponent stays a power, so R² still reads "R squared".
		let afterSpace = /ℝ\s*$/.test(prevText) || (/R\s*$/.test(prevText) && /×/.test(trimmed));
		if (!/[\p{L}\p{N}]/u.test(trimmed) && !MATH_CHAR_RE.test(trimmed) && !special) {
			// Bracket pieces of large delimiters, nothing to say
			speakText(raw, ctx, true, speaker, 0, true);
		}
		else if (node.style.sup && special && !afterSpace) {
			speaker.word(special, first);
		}
		else {
			let prefix = afterSpace ? ''
				: node.style.sup ? (/^\p{N}+$/u.test(trimmed) ? 'to the power' : 'superscript') : 'sub';
			speaker.word(prefix, first);
			speakText(raw, ctx, true, speaker, 0, true);
		}
		speaker.pieces.push({ text: ' ', src: null });
		return speaker.pieces;
	}

	function startsWithAccent(text) {
		return !!ACCENTS[text.trimStart()[0]];
	}

	// Ordinal suffixes ("20th") are typeset as superscripts but aren't math
	const ORDINAL_RE = /^(st|nd|rd|th|er|e|re|ème)$/i;

	function isScript(node) {
		return !!(node.style && (node.style.sup || node.style.sub))
			&& !(node.refs && node.refs.length)
			&& !(node.style.sup && ORDINAL_RE.test(node.text.trim()));
	}

	function visitInline(nodes, ctx, inMath, counter) {
		let prevText = '';
		for (let node of nodes) {
			if (!node || typeof node !== 'object') {
				continue;
			}
			if (Array.isArray(node.content)) {
				visitInline(node.content, ctx, inMath || node.type === 'math', counter);
				prevText = '';
				continue;
			}
			if (typeof node.text !== 'string' || !node.text) {
				continue;
			}
			// Monospace text is code (sometimes misfiled as math), where ">" and
			// "=" are syntax rather than something to read as a comparison
			if (node.style && node.style.monospace) {
				prevText = node.text;
				continue;
			}
			let original = node.text;
			if (isScript(node) && node.text.trim() && (inMath || attachesToMath(prevText))) {
				if (rewriteNode(node, speakScript(node, ctx, prevText))) {
					counter.nodes++;
				}
			}
			else if (inMath || MATH_CHAR_RE.test(node.text) || startsWithAccent(node.text)) {
				let mathy = inMath || /[=<>]/.test(node.text) && MATH_CHAR_RE.test(node.text);
				let speaker = speakText(node.text, ctx, mathy, new Speaker(prevText));
				if (rewriteNode(node, speaker.pieces)) {
					counter.nodes++;
				}
			}
			if (/\S/.test(original)) {
				prevText = original;
			}
		}
	}

	/**
	 * Rewrite math in place so Read Aloud speaks it in words. Returns how many
	 * text nodes changed.
	 */
	function verbalizeMath(structure) {
		let counter = { nodes: 0 };
		for (let block of structure?.content || []) {
			if (!block || block.flowClass === 'excluded' || !Array.isArray(block.content)) {
				continue;
			}
			// Tables and figures are read as plain labels, and code listings use
			// symbols like ">>>" and "=" as code, so we leave all three alone
			if (block.type === 'table' || block.type === 'image' || block.type === 'preformatted') {
				continue;
			}
			visitInline(block.content, { normOpen: false }, block.type === 'math', counter);
		}
		return counter.nodes;
	}

	return { verbalizeMath, decodeGlyphs, rewriteNode };
})();

if (typeof module !== 'undefined') {
	module.exports = MathSpeech;
}
