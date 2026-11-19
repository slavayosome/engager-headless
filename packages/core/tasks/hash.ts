import { createHash } from "node:crypto";

/** JSONB does not preserve object key order. Receipt identity must survive a
 * database round trip and semantically identical argument ordering. */
export function contextHash(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
            )
          : item,
      ),
    )
    .digest("hex");
}
