import type { StatusCodeRedirect } from "./types.js";

/**
 * Marks failures outside the contract's declared response union.
 *
 * These errors, when detected by the client are thrown, because they are
 * invariant and cannot be handled.
 */
export const sidechannelHeaderKey = "__typesafe_apis_error";
export type SidechannelHeaderValue = "internal_server_error" | "codec_error";

export class SidechannelError extends Error {
  constructor(
    readonly kind: SidechannelHeaderValue,
    readonly response: Response,
  ) {
    super(`Server reported unhandled ${kind} (HTTP ${response.status})`);
    this.name = "SidechannelError";
  }
}

/*
 * Adds sidechannel header on the response. It mutates the response and returns
 * it.
 */
export function withSidechannel(
  value: SidechannelHeaderValue,
  response: Response,
): Response {
  const headers = response.headers;
  headers.set(sidechannelHeaderKey, value);
  // Browser clients need to be able to read the marker on CORS responses too.
  const exposed = headers.get("access-control-expose-headers") ?? "";
  if (
    !exposed
      .split(",")
      .some((name) => name.trim().toLowerCase() === sidechannelHeaderKey)
  ) {
    headers.append("access-control-expose-headers", sidechannelHeaderKey);
  }
  return response;
}

export function getSidechannelHeader(
  response: Response,
): SidechannelHeaderValue | null {
  const raw = response.headers.get(sidechannelHeaderKey);
  return raw === "codec_error" || raw === "internal_server_error" ? raw : null;
}

/**
 *
 * Do `throw redirect(307, "/example")` to redirect the client.
 */
export function redirect(
  status: StatusCodeRedirect,
  url: string,
): RedirectError {
  return new RedirectError(status, url);
}

export class RedirectError extends Error {
  status: StatusCodeRedirect;
  url: string;

  constructor(status: StatusCodeRedirect, url: string) {
    super(`Redirect to ${url}`);
    this.name = "RedirectError";
    this.status = status;
    this.url = url;
  }
}

export function redirectResponse(error: RedirectError): Response {
  return new Response(null, {
    status: error.status,
    headers: {
      Location: error.url,
    },
  });
}
