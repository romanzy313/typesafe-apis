import { describe, expectTypeOf, it } from "vitest";
import { createClient, type ClientResponse } from "../client.js";
import { exampleFetch } from "./clientHandler.js";
import { exampleContract } from "./contract.js";
import { exampleEndpoint } from "./server.js";
import {
  exampleAuthService,
  type ExampleAuthServiceEnvironment,
} from "./dependencies.js";

const env: ExampleAuthServiceEnvironment = {
  authService: exampleAuthService(),
};

const fetchExample = createClient({
  baseUrl: "https://example.com",
  fetch: (request) => exampleEndpoint.fetchWithContext(request, env),
}).contract(exampleContract);

describe("example client types", () => {
  it("infers request and response types for the exported client", () => {
    expectTypeOf<typeof exampleFetch>().toEqualTypeOf<typeof fetchExample>();
    expectTypeOf(fetchExample).parameter(0).toEqualTypeOf<{
      params: { pathParam: number };
      query: { queryParam: "a" | "b" };
      body: { requestParam: boolean };
    }>();
    expectTypeOf(fetchExample).returns.resolves.toEqualTypeOf<
      ClientResponse<
        | {
            status: 200;
            body: {
              userId: string;
              pathParam: number;
              queryParam: string;
              requestParam: boolean;
            };
          }
        | { status: 400; body: { error: string } }
        | { status: 403; body: { error: "auth_please" } }
      >
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
