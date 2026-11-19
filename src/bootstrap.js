/* global Zotero, Services */

// Better Read Aloud
//
// Zotero's Read Aloud reads from a cached "structured document text" (SDT)
// pack that Zotero builds from each PDF. Manuscripts submitted for review
// carry margin line numbers, and the extractor folds those numbers into the
// paragraphs, so Read Aloud speaks them. Math is also stored as raw symbols
// that voices skip or garble, and abbreviations like "Eq." are mispronounced
// and break sentences in two. We wrap Zotero.SDT.getPack(), which is the
// single function the reader uses to fetch that pack, and hand back a copy
// with the line numbers removed and math and abbreviations spelled out. Zotero's own files and cache are never
// modified, so disabling or removing the plugin restores stock behavior.

var originalGetPack = null;
var lib = null;
// Patched packs keyed by item ID, so reopening a paper doesn't redo the work.
// We key on a cheap fingerprint of the original bytes too, because Zotero
// regenerates the pack whenever the PDF or its extractor version changes.
var cache = new Map();
var MAX_CACHE_ENTRIES = 20;

function log(msg) {
	Zotero.debug('[Better Read Aloud] ' + msg);
}

function fingerprint(bytes) {
	let view = new Uint8Array(bytes);
	let sum = view.byteLength;
	// Sampling the bytes is enough here because the pack header holds the
	// source file's hash, and a changed pack almost always changes its length
	let step = Math.max(1, Math.floor(view.byteLength / 4096));
	for (let i = 0; i < view.byteLength; i += step) {
		sum = (sum * 31 + view[i]) >>> 0;
	}
	return view.byteLength + ':' + sum;
}

async function patchPack(bytes) {
	let original = await lib.SDTPackLib.openPack(new Uint8Array(bytes));
	let structure = await original.materialize();
	let removed = lib.stripLineNumbers(structure);
	let mathNodes = lib.MathSpeech.verbalizeMath(structure);
	let abbreviations = lib.Abbreviations.expandAbbreviations(structure);
	if (!removed && !mathNodes && !abbreviations) {
		return { bytes: null, removed, mathNodes, abbreviations };
	}
	// The writer returns an ArrayBuffer, which matches what Zotero's getPack()
	// returns, so we can hand it straight back to the reader
	let patchedBytes = lib.SDTPackLib.pack(structure);

	// Zotero validates the pack format version when it reads the pack. If the
	// format we bundle ever drifts from the one this Zotero build expects, we'd
	// rather fall back to the untouched pack than break Read Aloud entirely.
	let patched = await lib.SDTPackLib.openPack(patchedBytes);
	if (patched.header.packVersion !== original.header.packVersion
			|| patched.header.schemaVersion !== original.header.schemaVersion) {
		throw new Error('Pack format mismatch after re-encoding');
	}
	return { bytes: patchedBytes, removed, mathNodes, abbreviations };
}

async function wrappedGetPack(itemID, options) {
	let result = await originalGetPack.call(this, itemID, options);
	if (!result || !result.ok || !result.bytes) {
		return result;
	}
	try {
		let key = fingerprint(result.bytes);
		let cached = cache.get(itemID);
		if (!cached || cached.key !== key) {
			let { bytes, removed, mathNodes, abbreviations } = await patchPack(result.bytes);
			cached = { key, bytes };
			cache.set(itemID, cached);
			if (cache.size > MAX_CACHE_ENTRIES) {
				cache.delete(cache.keys().next().value);
			}
			log(`item ${itemID}: removed ${removed} line numbers, spoke math in ${mathNodes} text nodes, `
				+ `expanded abbreviations in ${abbreviations}`);
		}
		if (!cached.bytes) {
			return result;
		}
		// Zotero hands each caller its own ArrayBuffer, so we do the same and copy
		return Object.assign({}, result, { bytes: cached.bytes.slice(0) });
	}
	catch (e) {
		// Any failure leaves Read Aloud exactly as stock Zotero would behave
		Zotero.logError(e);
		return result;
	}
}

async function startup({ rootURI }) {
	await Zotero.initializationPromise;
	if (!Zotero.SDT || typeof Zotero.SDT.getPack !== 'function') {
		log('Zotero.SDT.getPack not found; this Zotero version is not supported');
		return;
	}

	// The bundled pack code expects browser globals that a bootstrap scope
	// may not provide, so we borrow them from the main window when missing
	let win = Zotero.getMainWindow();
	lib = {
		TextEncoder: typeof TextEncoder !== 'undefined' ? TextEncoder : win.TextEncoder,
		TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : win.TextDecoder,
	};
	Services.scriptloader.loadSubScript(rootURI + 'sdt-pack.js', lib);
	Services.scriptloader.loadSubScript(rootURI + 'line-number-filter.js', lib);
	Services.scriptloader.loadSubScript(rootURI + 'math-speech.js', lib);
	Services.scriptloader.loadSubScript(rootURI + 'abbreviations.js', lib);

	originalGetPack = Zotero.SDT.getPack;
	Zotero.SDT.getPack = wrappedGetPack;
	log('enabled');
}

function shutdown() {
	if (originalGetPack && Zotero.SDT && Zotero.SDT.getPack === wrappedGetPack) {
		Zotero.SDT.getPack = originalGetPack;
	}
	originalGetPack = null;
	lib = null;
	cache.clear();
}

function install() {}

function uninstall() {}
