#!/usr/bin/env node

/**
 * The executable. Kept separate from `cli.ts` so the command logic stays importable and testable
 * without a side effect firing on import.
 */
import { run } from './cli.js';

/**
 * A closed pipe is not an error.
 *
 * `vinktar sourcemaps upload ./dist | head` closes stdout while this is still writing, and the
 * default handler turns that into an unhandled `EPIPE` and a non-zero exit — so a deploy step
 * that pipes the output into anything at all fails for reading its own logs.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });
}

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Anything that escaped `run`'s own handling. Printed rather than thrown, because an unhandled
    // rejection prints a stack trace of this file, which is never the interesting part.
    process.exitCode = 1;
    console.error(error instanceof Error ? error.message : String(error));
  },
);
