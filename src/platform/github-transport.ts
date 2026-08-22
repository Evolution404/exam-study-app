import { getPlatformEnvironment, type PlatformEnvironment } from "./environment";

/** The relay used by GitHub Pages and the native iOS container. */
export const GITHUB_RELAY_URL = "https://sync.980923.xyz";
export const GITHUB_WEB_RELAY_PATH = "/api-github";

/**
 * The sync layer only needs a fetch-compatible function and the logical
 * default API base. Keeping this adapter deliberately small preserves
 * Response.body streams, ETags, AbortController and all existing GitHub
 * protocol semantics in WKWebView.
 */
export interface GitHubTransport {
  fetch: typeof fetch;
  defaultApiBaseUrl: string;
}

export interface GitHubTransportOptions {
  environment?: PlatformEnvironment;
  hostname?: string;
  fetch?: typeof fetch;
}

function currentHostname(): string {
  return typeof location !== "undefined" ? location.hostname : "";
}

export function resolveTransportDefaultApiBaseUrl(
  hostname = currentHostname(),
  environment: PlatformEnvironment = getPlatformEnvironment(),
): string {
  if (environment.native) return GITHUB_RELAY_URL;
  return hostname.toLowerCase().endsWith(".github.io") ? GITHUB_RELAY_URL : GITHUB_WEB_RELAY_PATH;
}

/**
 * Normalize a persisted endpoint for the active platform. Only the old
 * same-origin default is migrated in native iOS; arbitrary user endpoints
 * remain untouched.
 */
export function resolveGitHubApiBaseUrl(
  configured: string | undefined,
  transport: GitHubTransport = getGitHubTransport(),
): string {
  const value = configured?.trim();
  if (!value) return transport.defaultApiBaseUrl;
  if (transport.defaultApiBaseUrl === GITHUB_RELAY_URL && value === GITHUB_WEB_RELAY_PATH) return GITHUB_RELAY_URL;
  return value;
}

export function createGitHubTransport(options: GitHubTransportOptions = {}): GitHubTransport {
  const environment = options.environment ?? getPlatformEnvironment();
  return {
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    defaultApiBaseUrl: resolveTransportDefaultApiBaseUrl(options.hostname, environment),
  };
}

let activeTransport: GitHubTransport | undefined;

/** Return the singleton transport used by all production sync operations. */
export function getGitHubTransport(): GitHubTransport {
  activeTransport ??= createGitHubTransport();
  return activeTransport;
}

/**
 * Test/native bootstrap seam. Production callers normally leave the default
 * transport untouched; tests can inject a fetch while retaining the endpoint
 * selection rules.
 */
export function setGitHubTransport(transport: GitHubTransport | undefined): void {
  activeTransport = transport;
}
