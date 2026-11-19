import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "@engager/common/errors";
import { audiencePainSchema, audienceProfileInputSchema, editableAudience, sameAudience, type AudienceProfile } from "./model";

export const AUDIENCE_UPDATE = "audience.update";
const profileShape = audienceProfileInputSchema.innerType().shape;
export const audienceChangeParts = {
  who: profileShape.who.optional(),
  pains: z.array(audiencePainSchema.innerType().pick({ id: true, text: true, phrases: true }).extend({
    id: z.string().min(1).max(100).optional(),
  })).max(12).optional(),
  notThem: profileShape.notThem.optional(),
};
export const audienceChangeSchema = z.object({
  kind: z.literal(AUDIENCE_UPDATE),
  campaignId: z.number().int().positive(),
  ...audienceChangeParts,
}).strict();
export type AudienceChange = z.infer<typeof audienceChangeSchema>;

export class NoAudienceChange extends AppError {
  readonly recovery = "Nothing was proposed. Send the part of the audience the owner asked to change.";
  constructor() { super("invalid_proposal", "Nothing was proposed. Send the part of the audience the owner asked to change.", 400); }
}

/** Resolve a proposed part against the canonical profile. A new pain gets its
 * identity once, when the card is drawn; existing identities stay stable. */
export function changedAudience(before: AudienceProfile, change: AudienceChange) {
  const pains = change.pains?.map((pain) => ({
    ...pain,
    id: pain.id ?? before.pains.find((old) => old.text.toLocaleLowerCase("en") === pain.text.toLocaleLowerCase("en"))?.id ?? randomUUID(),
    source: "owner" as const,
    status: "active" as const,
  }));
  const after = audienceProfileInputSchema.parse({
    ...editableAudience(before),
    ...(change.who === undefined ? {} : { who: change.who }),
    ...(pains === undefined ? {} : { pains }),
    ...(change.notThem === undefined ? {} : { notThem: change.notThem }),
  });
  if (sameAudience(editableAudience(before), after)) throw new NoAudienceChange();
  return after;
}
