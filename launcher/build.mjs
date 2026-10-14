#!/usr/bin/env node
// Build bin/grazer.exe from launcher/grazer-launcher.cs.
//
// Uses the .NET Framework compiler that ships with Windows, so building the
// launcher needs no SDK install. The result is a few kilobytes and byte-stable
// enough to commit, which is the point: users and CI get grazer.exe without a
// toolchain.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LAUNCHER_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(LAUNCHER_DIR, '..');
const SOURCE = join(LAUNCHER_DIR, 'grazer-launcher.cs');
const OUTPUT = join(REPO, 'bin', 'grazer.exe');

const FRAMEWORK_CSC = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];

/** The C# compiler, or null when this machine has none. */
export function findCsc() {
  for (const candidate of FRAMEWORK_CSC) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    const found = execFileSync('where', ['csc'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return found[0] ?? null;
  } catch {
    return null;
  }
}

export function buildLauncher({ csc = findCsc(), source = SOURCE, output = OUTPUT } = {}) {
  if (!csc) {
    throw new Error(
      'no C# compiler found. Expected the .NET Framework csc.exe at\n'
      + `  ${FRAMEWORK_CSC[0]}\n`
      + 'or csc on PATH.',
    );
  }
  mkdirSync(dirname(output), { recursive: true });
  execFileSync(csc, [
    '/nologo',
    '/target:exe',
    '/platform:anycpu',
    '/optimize+',
    '/warnaserror+',
    `/out:${output}`,
    source,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { output, bytes: statSync(output).size, csc };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const built = buildLauncher();
    console.log(`built ${built.output} (${built.bytes} bytes) with ${built.csc}`);
  } catch (err) {
    console.error(`launcher build failed: ${err.message}`);
    process.exitCode = 1;
  }
}
