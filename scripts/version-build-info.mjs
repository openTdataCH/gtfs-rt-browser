import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const outputDirectory = resolve(process.argv[2] ?? 'dist/gtfs-rt-viz/browser');
const indexPath = join(outputDirectory, 'index.html');
const metadata = readFileSync(join(outputDirectory, 'build-info.js'), 'utf8');
const version = createHash('sha256').update(metadata).digest('hex').slice(0, 16);
const html = readFileSync(indexPath, 'utf8');
const scriptReference = /src="build-info\.js(?:\?[^"]*)?"/;

if (!scriptReference.test(html)) throw new Error('Build metadata script missing from generated index.html');

writeFileSync(indexPath, html.replace(scriptReference, `src="build-info.js?v=${version}"`), 'utf8');
