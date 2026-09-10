import z from "zod";
import { contract } from "../contract.js";
import { zodCodec } from "../codec.js";

// from
// https://zod.dev/codecs#useful-codecs
const stringToNumber = z.codec(z.string().regex(z.regexes.number), z.number(), {
  decode: (str) => Number.parseFloat(str),
  encode: (num) => num.toString(),
});

const base = contract()
  .query(
    zodCodec(
      z.object({ queryParam: z.union([z.literal("a"), z.literal("b")]) }),
    ),
  )
  .response(400, zodCodec(z.object({ error: z.string() })));

export const exampleContract = base
  .route(
    "POST",
    "/test/:pathParam",
    zodCodec(z.object({ pathParam: stringToNumber })),
  )
  .request(zodCodec(z.object({ requestParam: z.boolean() })))
  .response(
    200,
    zodCodec(
      z.object({
        hi: z.string(),
        pathParam: z.number(),
        queryParam: z.string(),
        requestParam: z.boolean(),
      }),
    ),
  );
