import { randomBytes } from 'node:crypto';

/**
 * Building the upload body by hand instead of with `FormData`.
 *
 * Three reasons, in order of how much each one costs when it is missing:
 *
 * 1. **A proxy.** Node's `fetch` ignores `HTTPS_PROXY`, so a request through one has to go out
 *    over `node:https`, which needs bytes rather than a `FormData` object.
 * 2. **Per-part compression.** `Content-Encoding` does not survive multipart parsing — PHP hands
 *    the handler the raw part and nothing else — so a compressed part is just a part whose bytes
 *    happen to be gzip, detected by its magic number. That means putting exact bytes in a part.
 * 3. **Knowing the size before sending.** The ceiling that matters is the encoded request, not the
 *    sum of the files, and the framing is not free: a hundred parts is several kilobytes of
 *    boundaries and headers.
 */

export interface Part {
  readonly name: string;
  readonly value: string | Buffer;
  /** Present for a file part, absent for a plain field. */
  readonly filename?: string;
  readonly contentType?: string;
}

export interface Multipart {
  readonly body: Buffer;
  readonly contentType: string;
}

export function multipart(parts: readonly Part[]): Multipart {
  // Random rather than derived from the content: a boundary that appears inside a file would
  // truncate the request, and the odds of guessing 16 random bytes are not worth defending against
  // any other way.
  const boundary = `----vinktar${randomBytes(16).toString('hex')}`;
  const chunks: Buffer[] = [];

  for (const part of parts) {
    const disposition =
      part.filename === undefined
        ? `form-data; name="${escape(part.name)}"`
        : `form-data; name="${escape(part.name)}"; filename="${escape(part.filename)}"`;

    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: ${disposition}\r\n` +
          (part.contentType === undefined ? '' : `Content-Type: ${part.contentType}\r\n`) +
          '\r\n',
        'utf8',
      ),
    );
    chunks.push(typeof part.value === 'string' ? Buffer.from(part.value, 'utf8') : part.value);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * Quote what a header field cannot carry raw.
 *
 * Names here are ours (`files[]`, `urls[]`) and filenames come from a build directory, so this is
 * belt and braces — but a filename with a quote in it would otherwise end the field early and
 * mis-pair every part after it, which is the one failure in this format that is invisible.
 */
function escape(value: string): string {
  return value.replace(/[\r\n"]/g, (match) => (match === '"' ? '%22' : ''));
}

/** What one part costs on the wire beyond its own bytes, for planning a batch. */
export function overheadFor(part: Part): number {
  return (
    100 +
    Buffer.byteLength(part.name) +
    Buffer.byteLength(part.filename ?? '') +
    Buffer.byteLength(part.contentType ?? '')
  );
}
