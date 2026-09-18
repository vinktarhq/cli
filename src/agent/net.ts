import { reason } from '../http.js';
import { seconds } from '../upload.js';

/**
 * `fetch` for the agent commands: every request bounded, every network failure in words.
 *
 * Node's `fetch` has no timeout of its own, so a server that accepts the connection and then says
 * nothing held `vinktar status` open for as long as the terminal stayed open — and an agent
 * waiting on that command waits with it. And when the network is simply down it rejects with the
 * two words "fetch failed", which name neither the server nor what happened to it.
 *
 * Wrapped once here rather than at each call, so a request added later cannot forget either.
 */

/** Long enough for a slow query, short enough that an agent notices. */
export const REQUEST_TIMEOUT_MS = 30_000;

export class NetworkError extends Error {}

type Fetch = typeof fetch;

export function bounded(fetcher: Fetch = fetch, timeoutMs = REQUEST_TIMEOUT_MS): Fetch {
  return async (input, init) => {
    const host = hostOf(input);

    try {
      const response = await fetcher(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      // The body arrives under the same signal, so it is read here, inside the same deadline and
      // the same wording, and handed on as a response that is already complete.
      const body = await response.arrayBuffer();

      return new Response([204, 205, 304].includes(response.status) ? null : body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new NetworkError(`${host} did not answer within ${seconds(timeoutMs)}. Check the network, and that ${host} is the server you meant.`);
      }

      throw new NetworkError(`Could not reach ${host}: ${reason(error)}. Check the network, and that ${host} is the server you meant.`);
    }
  };
}

function hostOf(input: Parameters<Fetch>[0]): string {
  try {
    return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).host;
  } catch {
    return 'the server';
  }
}
