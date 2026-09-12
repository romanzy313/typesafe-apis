import { describe, expect, it } from "vitest";
import {
  getSidechannelHeader,
  RedirectError,
  redirectResponse,
  sidechannelHeaderKey,
  withSidechannel,
} from "./sidechannel.js";

describe("sidechannel headers", () => {
  it.each(["codec_error", "internal_server_error"] as const)(
    "marks %s while preserving the response and exposing the header to browsers",
    async (kind) => {
      const original = new Response("Failure", {
        status: 503,
        statusText: "Unavailable",
        headers: {
          [sidechannelHeaderKey]: "other",
          "x-request-id": "123",
          "access-control-expose-headers": "x-request-id",
        },
      });

      const response = withSidechannel(kind, original);

      expect(getSidechannelHeader(response)).toBe(kind);
      expect(response.status).toBe(503);
      expect(response.statusText).toBe("Unavailable");
      expect(response.headers.get("x-request-id")).toBe("123");
      expect(response.headers.get("access-control-expose-headers")).toBe(
        `x-request-id, ${sidechannelHeaderKey}`,
      );
      expect(await response.text()).toBe("Failure");
    },
  );

  it("mutates response headers", () => {
    const original = redirectResponse(
      new RedirectError(307, "https://example.com"),
    );
    const response = withSidechannel("internal_server_error", original);

    expect(response).toBe(original);
    expect(getSidechannelHeader(original)).toBe("internal_server_error");
    expect(original.headers.get("location")).toBe("https://example.com");
    expect(original.headers.get("access-control-expose-headers")).toBe(
      sidechannelHeaderKey,
    );
  });

  it("preserves an existing case-insensitive exposure entry", () => {
    const exposed = `${sidechannelHeaderKey.toUpperCase()}, x-request-id`;
    const response = withSidechannel(
      "codec_error",
      new Response(null, {
        status: 400,
        headers: { "access-control-expose-headers": exposed },
      }),
    );

    expect(response.headers.get("access-control-expose-headers")).toBe(exposed);
  });

  it.each([
    undefined,
    "",
    "future_error",
    "CODEC_ERROR",
    "codec_error, internal_server_error",
  ])("does not recognize %s as an invariant", (value) => {
    const headers = new Headers();
    if (value !== undefined) headers.set(sidechannelHeaderKey, value);
    expect(getSidechannelHeader(new Response(null, { headers }))).toBeNull();
  });
});
