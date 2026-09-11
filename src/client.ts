import {
  compileContract,
  type ContractBuilder,
  type InferRequest,
  type ReadyContractState,
} from "./contract.js";
import type {
  Codec,
  ContractResponse,
  MinFetch,
  RequestExtract,
  RequestMethod,
  ResponseCodecs,
  TypedRequest,
} from "./types.js";

export type ClientOptions = {
  // Prefix for endpoint paths; omit for browser-relative or absolute URLs.
  baseUrl?: string;
  fetch?: MinFetch;
};

export type TypesafeFetch<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
> = (
  typedRequest: TypedRequest<TParams, TQuery, TRequestBody>,
) => Promise<ContractResponse<TResponses>>;

export type Client = {
  contract<TState extends ReadyContractState>(
    c: ContractBuilder<TState>,
  ): TypesafeFetch<
    TState["params"],
    TState["query"],
    TState["request"],
    TState["responses"]
  >;
};

export function createClient(opts: ClientOptions = {}): Client {
  const baseUrl = opts.baseUrl ?? "";
  const fetch = opts.fetch ?? globalThis.fetch;

  return {
    contract<TState extends ReadyContractState>(
      c: ContractBuilder<TState>,
    ): TypesafeFetch<
      TState["params"],
      TState["query"],
      TState["request"],
      TState["responses"]
    > {
      const definition = compileContract(c);

      function encodeRequest(
        req: InferRequest<ContractBuilder<TState>>,
      ): RequestExtract {
        const params = definition.params.encode(req.params);
        assertParams(params);
        const query = definition.query.encode(req.query);
        assertQuery(query);

        return {
          params,
          query,
          body: definition.request.encode(req.body),
          headers: req.headers,
        };
      }
      function decodeResponse(
        response: Awaited<ReturnType<typeof extractJsonResponse>>,
      ): ContractResponse<TState["responses"]> {
        const codecs: Partial<Record<number, Codec>> = definition.responses;
        const codec = codecs[response.status];
        if (!codec) {
          throw new Error(`No decoder for status ${response.status}`);
        }

        // The selected codec validates the body for this declared status.
        return {
          status: response.status,
          body: codec.decode(response.body),
        } as ContractResponse<TState["responses"]>;
      }

      return async (
        typedRequest: InferRequest<ContractBuilder<TState>>,
      ): Promise<ContractResponse<TState["responses"]>> => {
        const encodedRequest = encodeRequest(typedRequest);

        const request = createJsonRequest(
          encodedRequest,
          baseUrl,
          definition.method,
          definition.path,
        );

        const response = await fetch(request);
        const responseExtract = await extractJsonResponse(response);

        return decodeResponse(responseExtract);
      };
    },
  };
}

function assertParams(
  params: unknown,
): asserts params is RequestExtract["params"] {
  if (
    typeof params !== "object" ||
    params === null ||
    Array.isArray(params) ||
    Object.values(params).some((value) => typeof value !== "string")
  ) {
    throw new TypeError("Encoded params must be an object of strings");
  }
}

function assertQuery(query: unknown): asserts query is RequestExtract["query"] {
  if (
    typeof query !== "object" ||
    query === null ||
    Array.isArray(query) ||
    Object.values(query).some((value) => typeof value !== "string")
  ) {
    throw new TypeError("Encoded query must be an object of strings");
  }
}

function createJsonRequest(
  requestExtract: RequestExtract,
  baseUrl: string,
  method: RequestMethod,
  path: string,
): Request {
  const pathname = path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment;

      const name = segment.slice(1);
      const value = requestExtract.params[name];
      if (!Object.hasOwn(requestExtract.params, name) || value === undefined) {
        throw new Error(`Missing path parameter ${name}`);
      }
      return encodeURIComponent(value);
    })
    .join("/");
  const url = baseUrl
    ? `${baseUrl.replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`
    : pathname;
  const query = new URLSearchParams(requestExtract.query).toString();
  const body =
    requestExtract.body === undefined
      ? null
      : JSON.stringify(requestExtract.body);
  const headers = new Headers(requestExtract.headers);
  if (body !== null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return new Request(query ? `${url}?${query}` : url, {
    method,
    headers,
    body,
  });
}

async function extractJsonResponse(response: Response) {
  const body: unknown =
    response.body === null ? undefined : await response.json();

  return { status: response.status, body, headers: response.headers };
}
