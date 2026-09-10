import { describe, expectTypeOf, it } from "vitest";
import { createClient } from "../client.js";
// import type { exampleFetch } from "./clientHandler.js";
import { exampleContract } from "./contract.js";
import { exampleHandler } from "./serverHandler.js";

const fetchExample = createClient({
  baseUrl: "https://example.com",
  fetch: (request) => exampleHandler.fetchWithContext(request, {}),
}).contract(exampleContract);

describe("example client types", () => {
  it("infers request and response types for the exported client", () => {
    const exampleFetch = createClient().contract(exampleContract);

    expectTypeOf<typeof exampleFetch>().toEqualTypeOf<typeof fetchExample>();
    expectTypeOf(fetchExample).parameter(0).toEqualTypeOf<{
      params: { pathParam: number };
      query: { queryParam: "a" | "b" };
      body: { requestParam: boolean };
    }>();
    expectTypeOf(fetchExample).returns.resolves.toEqualTypeOf<
      | {
          status: 200;
          body: {
            hi: string;
            pathParam: number;
            queryParam: string;
            requestParam: boolean;
          };
        }
      | { status: 400; body: { error: string } }
    >();
  });

  it("rejects arguments outside the shared contract", () => {
    const input = {
      params: { pathParam: 42 },
      query: { queryParam: "a" as const },
      body: { requestParam: true },
    };

    expectTypeOf(fetchExample).toBeCallableWith({
      ...input,
      // @ts-expect-error The decoded path parameter is a number.
      params: { pathParam: "42" },
    });
    expectTypeOf(fetchExample).toBeCallableWith({
      ...input,
      // @ts-expect-error Only query values a and b are declared.
      query: { queryParam: "c" },
    });
    expectTypeOf(fetchExample).toBeCallableWith({
      ...input,
      // @ts-expect-error The request field is a boolean.
      body: { requestParam: "true" },
    });
  });
});
