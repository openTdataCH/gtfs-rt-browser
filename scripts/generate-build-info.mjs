import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const development = process.argv.includes('--development');
const outputDirectory = new URL('../public/', import.meta.url);
const outputPath = new URL('../public/build-info.js', import.meta.url);

const buildInfo = development
  ? undefined
  : {
      commit: commitSha(),
      builtAt: new Date().toISOString()
    };

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(outputPath, `window.__GTFS_RT_BUILD_INFO__ = ${JSON.stringify(buildInfo)};\n`, 'utf8');

function commitSha() {
  const environmentSha = process.env['GTFS_RT_BUILD_SHA']?.trim();
  if (environmentSha) return environmentSha;

  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  }).trim();
}
