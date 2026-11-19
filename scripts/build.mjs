// Builds the installable XPI and the update manifest Zotero polls for new
// versions. Both land in build/ and are attached to each GitHub release.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';
import { zipSync, strToU8 } from 'fflate';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { version } = manifest;
const { id } = manifest.applications.zotero;
const repo = 'https://github.com/zfergus/zotero-better-read-aloud';
const xpiName = `zotero-better-read-aloud-${version}.xpi`;

mkdirSync('build', { recursive: true });

// We bundle the pack code as a plain script that defines one global,
// because the plugin loads it with Services.scriptloader.loadSubScript()
const bundle = await build({
	entryPoints: ['src/sdt-pack-entry.js'],
	bundle: true,
	format: 'iife',
	globalName: 'SDTPackLib',
	target: 'firefox115',
	write: false,
	logLevel: 'warning',
});

const files = {
	'manifest.json': readFileSync('manifest.json'),
	'bootstrap.js': readFileSync('src/bootstrap.js'),
	'line-number-filter.js': readFileSync('src/line-number-filter.js'),
	'math-speech.js': readFileSync('src/math-speech.js'),
	'sdt-pack.js': bundle.outputFiles[0].contents,
	'LICENSE': readFileSync('LICENSE'),
};
// A fixed timestamp keeps the XPI byte-for-byte reproducible between builds
const mtime = new Date('2026-01-01T00:00:00Z');
const zipInput = Object.fromEntries(
	Object.entries(files).map(([name, data]) => [name, [data, { mtime }]])
);
writeFileSync(`build/${xpiName}`, zipSync(zipInput, { level: 9 }));

const updates = {
	addons: {
		[id]: {
			updates: [{
				version,
				update_link: `${repo}/releases/download/v${version}/${xpiName}`,
				applications: {
					zotero: {
						strict_min_version: manifest.applications.zotero.strict_min_version,
						strict_max_version: manifest.applications.zotero.strict_max_version,
					},
				},
			}],
		},
	},
};
writeFileSync('build/updates.json', JSON.stringify(updates, null, 2) + '\n');

console.log(`Built build/${xpiName} and build/updates.json`);
