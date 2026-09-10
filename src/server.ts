import type {
  Codec,
  Contract,
  ContractResponse,
  MinFetch,
  RequestExtract,
  ResponseCodecs,
  ResponseExtract,
  TypedRequest,
} from "./types.js";

export type ServerHandler<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
> = {
  definition: Contract<
    Codec<TParams>,
    Codec<TQuery>,
    Codec<TRequestBody>,
    TResponses
  >["definition"];
  handler: (
    req: NoInfer<TypedRequest<TParams, TQuery, TRequestBody>>,
  ) => Promise<ContractResponse<NoInfer<TResponses>>>;
  fetch: MinFetch;
};

export function serverContractHandler<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
>(
  c: Contract<Codec<TParams>, Codec<TQuery>, Codec<TRequestBody>, TResponses>,
  handler: ServerHandler<TParams, TQuery, TRequestBody, TResponses>["handler"],
): ServerHandler<TParams, TQuery, TRequestBody, TResponses> {
  const { definition } = c;
  if (!definition.route) {
    throw new Error("Contract must define a route with .route()");
  }

  function decodeRequest(req: RequestExtract) {
    return {
      params: definition.params.decode(req.params),
      query: definition.query.decode(req.query),
      body: definition.request.decode(req.body),
    };
  }
  function encodeResponse(res: ResponseExtract) {
    const codec = definition.responses[res.status];
    if (!codec) throw new Error(`No encoder for status ${res.status}`);

    return {
      status: res.status,
      body: codec.encode(res.body),
    };
  }

  async function fetch(request: Request) {
    const requestExtract = await extractJsonRequest(
      request,
      definition.route.path,
    );
    const decodedRequest = decodeRequest(requestExtract);

    const response = await handler(decodedRequest);

    const encodedResponse = encodeResponse(response);
    return createJsonResponse(encodedResponse);
  }

  return {
    definition,
    handler, // for testing
    fetch,
  };
}

export type ConcreteRequest = {
  path: string; // make the path from params + query
  body: string; // for now?
};

async function extractJsonRequest(
  req: Request,
  path: string,
): Promise<RequestExtract> {
  const url = new URL(req.url);
  const pathSegments = path.split("/");
  const requestSegments = url.pathname.split("/");

  if (pathSegments.length !== requestSegments.length) {
    throw new Error(`Request path does not match ${path}`);
  }

  const params = Object.fromEntries(
    pathSegments.flatMap((segment, index) => {
      const value = requestSegments[index];
      if (segment.startsWith(":")) {
        if (!value) throw new Error(`Request path does not match ${path}`);
        return [[segment.slice(1), decodeURIComponent(value)]];
      }
      if (segment !== value) {
        throw new Error(`Request path does not match ${path}`);
      }
      return [];
    }),
  );

  return {
    params,
    query: Object.fromEntries(url.searchParams),
    body: req.body === null ? undefined : await req.json(),
  };
}

function createJsonResponse(responseExtract: ResponseExtract): Response {
  return Response.json(responseExtract.body, {
    status: responseExtract.status,
  });
}
