import z from "zod";
import { contract } from "../contract.js";
import { zodCodec } from "../codec.js";

// from
// https://zod.dev/codecs#useful-codecs
const stringToNumber = z.codec(z.string().regex(z.regexes.number), z.number(), {
  decode: (str) => Number.parseFloat(str),
  encode: (num) => num.toString(),
});

export const exampleContract = contract({
  method: "POST",
  path: "/test/:pathParam",
  params: zodCodec(
    z.object({
      pathParam: stringToNumber,
    }),
  ),
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
