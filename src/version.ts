/**
 * The published version, kept by hand.
 *
 * Its own module so the HTTP layer can put it in a `User-Agent` without importing the CLI's
 * argument parser, which would make every plugin drag the command surface into a build.
 *
 * A test asserts it matches `package.json`, and `prepublishOnly` runs that test — reading the
 * manifest at runtime instead would mean resolving a path that moves between `src` and `dist`.
 */
export const VERSION = '0.1.0';
