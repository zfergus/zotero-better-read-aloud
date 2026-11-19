# Better Read Aloud

A Zotero 10+ plugin that stops Read Aloud from speaking the margin line numbers in manuscripts submitted for review, such as conference and journal review copies.

Line numbers cause more than stray "12, 13, 14" interruptions. Zotero's text extraction folds them into the paragraphs, so lines get misread as numbered list items, Read Aloud pauses after every line, and words hyphenated across lines are read as two halves ("measure- ment"). This plugin fixes all three.

## Install

Download the latest `zotero-better-read-aloud-*.xpi` from [Releases](https://github.com/zfergus/zotero-better-read-aloud/releases). In Zotero, open **Tools → Plugins**, click the gear menu, choose **Install Plugin From File…**, and select the XPI. Reopen any paper that's already open. Zotero checks this repo for updates automatically.

## How it works

Read Aloud reads from a cached "structured document text" pack that Zotero builds from each PDF. The plugin wraps `Zotero.SDT.getPack()`, the function the reader uses to fetch that pack, and returns an edited copy:

1. **Find the line numbers.** Line numbers form long, nearly consecutive runs (1, 2, 3, …) in reading order, packed at 50–70 per page. Footnote markers, reference lists, and tables of contents also count upward, but only a handful per page, so we only remove runs with at least 30 numbers per page.
2. **Undo the fake lists.** Lines misread as numbered list items are merged back into a paragraph.
3. **Rejoin hyphenated words.** We mark line-break hyphens as soft hyphens, the same way Zotero does for PDFs without line numbers. The hyphen leaves the spoken text but stays in the position map, so highlighting still lines up. Suspended hyphens ("short- and long-term") are kept.
4. **Relink split paragraphs.** Paragraphs that continue across a column or page are linked again, so Read Aloud reads them without a pause.

Zotero's cache and your PDFs are never modified. If anything fails, the plugin returns Zotero's original text, and disabling the plugin restores stock behavior.

## Limitations

- A Read Aloud position saved in a paper before installing may reset once.
- Line numbers that the extractor merged into neighboring text (common in reference-list URLs) are not removed.
- Templates that only number every fifth line are too sparse to detect and are left alone.

## Development

```sh
git clone --recurse-submodules https://github.com/zfergus/zotero-better-read-aloud.git
npm install
npm test        # behavior tests for the filter
npm run build   # writes build/zotero-better-read-aloud-<version>.xpi and build/updates.json
```

To release, bump `version` in `manifest.json` and `package.json`, then push a matching `v<version>` tag. The workflow builds the XPI and attaches it and `updates.json` to a GitHub release.

## License

AGPL-3.0, because the plugin bundles code from [zotero/structured-document-text](https://github.com/zotero/structured-document-text).
