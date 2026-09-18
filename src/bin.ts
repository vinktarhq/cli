#!/usr/bin/env node

/**
 * The executable. Kept separate from `cli.ts` so the command logic stays importable and testable
 * without a side effect firing on import.
 */
import { escaped, run, streamFailed } from './cli.js';

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    // When it is stderr that broke there is nowhere left to say so; the exit code still says it.
    streamFailed(error, stream === process.stderr ? (): void => {} : console.error);
  });
}

run(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, escaped);
