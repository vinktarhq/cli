/**
 * Derives the `urls[]` value the server matches a frame against.
 *
 * `urls[]` is not optional in practice, and this is the one part of the contract most likely to be
 * got wrong: `docs/API.md` omits the field entirely, but if a file's resolved debug id is empty
 * AND its normalised url is empty, the server answers 400 and rolls back the WHOLE upload — not
 * just that file.
 *
 * The server normalises what it stores by stripping the query, the fragment, and then the scheme
 * and host, leaving a path. It applies the identical normalisation to the `file` on a runtime
 * frame before comparing. So `https://cdn.example.com/assets/app.js?v=2` and `/assets/app.js`
 * match, and a prefix that is a full origin is just as correct as one that is a bare path.
 */

/**
 * @param prefix   what the file is served under: `/assets/`, `https://cdn.example.com/`, or `~/`
 * @param relative the file's path relative to the upload root
 */
export function toUrl(prefix: string, relative: string): string {
  const left = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const right = relative.startsWith('/') ? relative.slice(1) : relative;

  return `${left}${right}`;
}

/**
 * The server's own normalisation, reproduced so `--dry-run` can show what will actually be stored.
 *
 * Printing this is the difference between "the upload succeeded but nothing symbolicates" and a
 * mismatch someone can see before spending a minute uploading.
 */
export function normalise(url: string): string {
  let value = url.split('#')[0] ?? '';
  value = value.split('?')[0] ?? '';

  const scheme = value.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i);
  if (scheme) value = value.slice(scheme[0].length);

  // `~/` is the conventional "wherever this is served from" prefix; it is not part of the path.
  if (value.startsWith('~')) value = value.slice(1);

  return value.startsWith('/') ? value : `/${value}`;
}
