import { OAuthError, refresh } from './oauth.js';
import { load, save, type Session } from './store.js';

/**
 * A minimal MCP client: JSON-RPC over one POST, which is all the Vinktar server speaks (stateless,
 * no streaming). It exists so a harness without MCP support — pi, Aider, a shell script, a CI job —
 * can reach the same tools an editor would, by running a command.
 */

export const DEFAULT_MCP_URL = 'https://mcp.vinktar.com/mcp';
const PROTOCOL_VERSION = '2025-06-18';
/** Refresh this long before the access token runs out, so a call never races its expiry. */
const EARLY_MS = 60_000;

export interface Tool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: { properties?: Record<string, { description?: string; type?: string }>; required?: string[] };
  readonly annotations?: { readOnlyHint?: boolean };
}

export interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}

export class McpError extends Error {}

type Fetch = typeof fetch;

export class McpClient {
  private id = 0;

  constructor(
    private readonly url: string,
    private session: Session,
    private readonly fetcher: Fetch = fetch,
    private readonly credentials?: string,
  ) {}

  static async signedIn(url: string, fetcher: Fetch = fetch, credentials?: string): Promise<McpClient> {
    const { session } = await load(url, credentials);
    if (session === undefined) throw new McpError(`Not signed in to ${url}. Run: vinktar login`);

    return new McpClient(url, session, fetcher, credentials);
  }

  private async fresh(force = false): Promise<void> {
    if (!force && this.session.expiresAt - EARLY_MS > Date.now()) return;

    this.session = await refresh(this.session, this.url, this.fetcher);
    const remembered = await load(this.url, this.credentials);
    await save(this.url, { ...remembered, clientId: this.session.clientId, session: this.session }, this.credentials);
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.fresh();

    const send = (): Promise<Response> =>
      this.fetcher(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.session.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': PROTOCOL_VERSION,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
      });

    let response = await send();
    // The token was revoked or rotated behind our back: one refresh, one retry, then say so.
    if (response.status === 401) {
      try {
        await this.fresh(true);
      } catch (error) {
        throw error instanceof OAuthError ? new McpError(error.message) : error;
      }
      response = await send();
    }
    if (response.status === 401) throw new McpError('The server refused this session. Run: vinktar login');

    type Envelope = { result?: T; error?: { message?: string } };
    const text = await response.text();
    let body: Envelope;
    try {
      body = JSON.parse(text) as Envelope;
    } catch {
      throw new McpError(`${this.url} answered ${response.status} with something that is not JSON.`);
    }
    if (body.error !== undefined) throw new McpError(body.error.message ?? 'The server returned an error.');
    if (!response.ok || body.result === undefined) throw new McpError(`${this.url} answered ${response.status}.`);

    return body.result;
  }

  async tools(): Promise<Tool[]> {
    const result = await this.request<{ tools?: Tool[] }>('tools/list');

    return result.tools ?? [];
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.request<{ content?: { type: string; text?: string }[]; isError?: boolean }>('tools/call', {
      name,
      arguments: args,
    });

    return {
      text: (result.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n'),
      isError: result.isError === true,
    };
  }

  async resource(uri: string): Promise<string> {
    const result = await this.request<{ contents?: { text?: string }[] }>('resources/read', { uri });

    return (result.contents ?? []).map((part) => part.text ?? '').join('\n');
  }
}
