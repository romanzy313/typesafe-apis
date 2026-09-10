import type {
  Codec,
  Contract,
  ContractResponse,
  RequestExtract,
  ResponseCodecs,
  ResponseExtract,
  StatusCode,
  TypedRequest,
} from "./types.js";

export type ClientOptions = {
  baseUrl?: string;
  // minimal fetch here
  doRequest: (request: Request) => Promise<Response>;
};

export type TypesafeFetch<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
> = (
  typedRequest: NoInfer<TypedRequest<TParams, TQuery, TRequestBody>>,
) => Promise<ContractResponse<NoInfer<TResponses>>>;

export type Client = {
  contract<TParams, TQuery, TRequestBody, TResponses extends ResponseCodecs>(
    c: Contract<Codec<TParams>, Codec<TQuery>, Codec<TRequestBody>, TResponses>,
  ): TypesafeFetch<TParams, TQuery, TRequestBody, TResponses>;
};

export function createClient(opts: ClientOptions): Client {
  const baseUrl = opts.baseUrl ?? "";
  const doRequest = opts.doRequest;

  return {
    contract<TParams, TQuery, TRequestBody, TResponses extends ResponseCodecs>(
      c: Contract<
        Codec<TParams>,
        Codec<TQuery>,
        Codec<TRequestBody>,
        TResponses
      >,
    ): TypesafeFetch<TParams, TQuery, TRequestBody, TResponses> {
      function encodeRequest(
        req: NoInfer<TypedRequest<TParams, TQuery, TRequestBody>>,
      ): RequestExtract {
        return {
          params: c.params.encode(req.params),
          query: c.query.encode(req.query),
          body: c.request.encode(req.body),
        };
      }
      function decodeResponse(res: ResponseExtract) {
        const codec = c.responses[res.status];
        if (!codec) throw new Error(`No encoder for status ${res.status}`);

        return {
          status: res.status,
          body: codec.decode(res.body),
        };
      }

      return async (
        typedRequest: NoInfer<TypedRequest<TParams, TQuery, TRequestBody>>,
      ): Promise<ContractResponse<NoInfer<TResponses>>> => {
        const encodedRequest = encodeRequest(typedRequest);

        const request = createJsonRequest(encodedRequest, c.path, baseUrl);

        const response = await doRequest(request);

        const responseExtract = await extractJsonResponse(response); // this could fail too? like body ended due to network error
        const decodedResponse = decodeResponse(responseExtract);

        return decodedResponse;
      };
    },
  };
}

function createJsonRequest(
  requestExtract: RequestExtract,
  path: string,
  baseUrl: string,
): Request {
  // TODO
  return new Request("TODO");
}

async function extractJsonResponse(
  response: Response,
): Promise<ResponseExtract> {
  return {
    status: response.status as StatusCode,
    body: await response.json(), // TODO
  };
}
