import z from "zod";
import { contract, serverContractHandler, type Codec } from "./prototype.js";

export function zodCodec<TInput>(schema: z.ZodType<TInput>): Codec<TInput> {
  return {
    encode: (value: TInput) => schema.encode(value),
    decode: (value: unknown) => schema.decode(value),
  };
}

const example = contract({
  method: "POST",
  path: "/test/:pathParam",
  params: zodCodec(z.object({ pathParam: z.number() })),
  query: zodCodec(
    z.object({ queryParam: z.union([z.literal("a"), z.literal("b")]) }),
  ),
  request: zodCodec(
    z.object({
      requestParam: z.boolean(),
    }),
  ),
  responses: {
    200: zodCodec(
      z.object({
        hi: z.string(),
        pathParam: z.number(),
        queryParam: z.string(),
        requestParam: z.boolean(),
      }),
    ),
    400: zodCodec(z.object({ error: z.string() })),
  },
});

const h = serverContractHandler(example, async (req) => {
  return {
    status: 200,
    body: {
      hi: "",
      pathParam: req.params.pathParam,
      queryParam: req.query.queryParam,
      requestParam: req.body.requestParam,
    },
  };
});
