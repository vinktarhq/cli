/**
 * The limits the ingest API enforces.
 *
 * Fallbacks, not the truth: `POST /v1/sourcemaps/check` publishes what a deployment actually
 * accepts, and the client prefers that (see {@link ../upload.js}). These are what it uses before
 * it has asked, and against an older ingest that does not publish them — so a 60 MB upload fails
 * in a second with a clear message rather than after the bytes have crossed the wire.
 */

/** Per map. Over this the server answers 413 file_too_large. */
export const MAX_FILE_BYTES = 20_971_520;

/** Whole multipart request. */
export const MAX_REQUEST_BYTES = 62_914_560;

/**
 * What one request should carry when the server is configured as the protocol says.
 *
 * The server publishes its own figure as `maxBatchBytes` at `POST /v1/sourcemaps/check`, computed
 * from its actual `post_max_size`; this is the same number the protocol recommends, mirrored so a
 * test can assert the two have not drifted.
 */
export const RECOMMENDED_BATCH_BYTES = 16_777_216;

/**
 * What one request carries when the server says nothing.
 *
 * An ingest that does not publish `limits` is one deployed before they existed, and a deployment
 * that old is one whose `post_max_size` is very likely PHP's stock 8M. A POST over that is not
 * rejected — the body is silently discarded and the server answers `missing_release`, which reads
 * like a CLI bug and cost an afternoon to diagnose the first time. Batching under the ini default
 * works everywhere; the extra requests cost seconds.
 */
export const CONSERVATIVE_BATCH_BYTES = 6_000_000;

/** The longest a release or dist name may be. Over it the server answers `invalid_release`. */
export const MAX_NAME_BYTES = 64;

/** Source-map upload needs `cli` scope, NOT `write`. A write key alone gets a 403. */
export const REQUIRED_SCOPE = 'cli';

export const DEFAULT_HOST = 'https://in.vinktar.com';
