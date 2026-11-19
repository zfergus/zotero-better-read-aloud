# Better Read Aloud

A Zotero 10+ plugin that makes Read Aloud work better on papers. It does three things:

- **Skips line numbers.** Manuscripts submitted for review carry margin line numbers. Zotero's text extraction folds them into the paragraphs, so Read Aloud speaks them, lines get misread as numbered list items, Read Aloud pauses after every line, and words hyphenated across lines are read as two halves ("measure- ment"). The plugin fixes all of that.
- **Speaks math in words.** PDF text stores math as raw symbols, which voices skip or garble. The plugin reads "∥v∥² ≤ α" as "norm of v squared less than or equal to alpha", and highlighting still follows along on the original symbols.
- **Expands abbreviations.** Voices pronounce "Fig." and "Eq." literally, and Zotero treats their periods as sentence ends, so Read Aloud stops mid-sentence. The plugin reads them as "Figure" and "Equation", along with "Sec.", "Alg.", "Tab.", "e.g.", "i.e." and similar.

## Install

Download the latest `zotero-better-read-aloud-*.xpi` from [Releases](https://github.com/zfergus/zotero-better-read-aloud/releases). In Zotero, open **Tools → Plugins**, click the gear menu, choose **Install Plugin From File…**, and select the XPI. Reopen any paper that's already open. Zotero checks this repo for updates automatically.

## How it works

Read Aloud reads from a cached "structured document text" pack that Zotero builds from each PDF. The plugin wraps `Zotero.SDT.getPack()`, the function the reader uses to fetch that pack, and returns an edited copy:

1. **Find the line numbers.** Line numbers form long, nearly consecutive runs (1, 2, 3, …) in reading order, packed at 50–70 per page. Footnote markers, reference lists, and tables of contents also count upward, but only a handful per page, so we only remove runs with at least 30 numbers per page.
2. **Undo the fake lists.** Lines misread as numbered list items are merged back into a paragraph.
3. **Rejoin hyphenated words.** We mark line-break hyphens as soft hyphens, the same way Zotero does for PDFs without line numbers. The hyphen leaves the spoken text but stays in the position map, so highlighting still lines up. Suspended hyphens ("short- and long-term") are kept.
4. **Relink split paragraphs.** Paragraphs that continue across a column or page are linked again, so Read Aloud reads them without a pause.
5. **Spell out math.** Greek letters, operators, accents ("x hat"), norms, subscripts ("x sub i") and superscripts ("squared", "inverse", "transpose") become words, in display equations and inline. Each text node carries a map from characters to glyph boxes on the page, so we rebuild that map too: every letter of "alpha" points at the α glyph, and highlighting stays aligned. Footnote markers, ordinals ("20th"), and code listings are left alone.
6. **Expand abbreviations.** Pointers like "Fig.", "Eq.", "Sec.", "Alg." and "Thm." become full words when a number, bracket or space follows, and "e.g.", "i.e.", "cf.", "vs." and "w.r.t." become "for example", "that is", "compare", "versus" and "with respect to". Zotero deliberately skips bracketed links like "(Fig. 3)", but it also drops the number from "Equation (4)", so we unlink equation numbers that follow "Eq." and Read Aloud speaks them. Those numbers lose their link in Zotero's reflowed text view only; links on the PDF page still work.

Zotero's cache and your PDFs are never modified. If anything fails, the plugin returns Zotero's original text, and disabling the plugin restores stock behavior.

## Limitations

- A Read Aloud position saved in a paper before installing may reset once.
- Line numbers that the extractor merged into neighboring text (common in reference-list URLs) are not removed.
- Templates that only number every fifth line are too sparse to detect and are left alone.
- Fractions, roots and matrices are flattened when Zotero extracts PDF text, so complex equations are read as a best-effort sequence of terms. A fraction like one over two may come out as "1 2" or "1 sub 2".

## Development

```sh
git clone --recurse-submodules https://github.com/zfergus/zotero-better-read-aloud.git
npm install
npm test        # behavior tests for line numbers, math speech and abbreviations
npm run build   # writes build/zotero-better-read-aloud-<version>.xpi and build/updates.json
```

To release, bump `version` in `manifest.json` and `package.json`, then push a matching `v<version>` tag. The workflow builds the XPI and attaches it and `updates.json` to a GitHub release.

## License

AGPL-3.0, because the plugin bundles code from [zotero/structured-document-text](https://github.com/zotero/structured-document-text).
