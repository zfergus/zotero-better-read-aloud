// We bundle just the pack reader and writer from zotero/structured-document-text,
// plus a raw DEFLATE implementation. Together they let the plugin decode the
// structured text Zotero caches for each PDF, edit it, and encode it again.
import { deflateSync, inflateSync } from 'fflate';
import { openStructuredDocumentTextPack } from '../vendor/structured-document-text/src/pack/reader.js';
import { packStructuredDocumentText } from '../vendor/structured-document-text/src/pack/writer.js';

export function openPack(bytes) {
	return openStructuredDocumentTextPack(bytes, { inflate: b => inflateSync(b) });
}

export function pack(structure) {
	return packStructuredDocumentText(structure, { deflate: b => deflateSync(b) });
}
