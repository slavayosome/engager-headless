import { createHash } from "node:crypto";
import type { PostInput, PostResult, RoomReplyInput, WriteOutcomeResolutionResult } from "./driver";
import { MockDriver } from "./mock";

type RoomReceipt = {
  fingerprint: string;
  result: { state: "confirmed"; externalUrn: string } | { state: "uncertain" | "absent" | "failed" };
  released: boolean;
  version: number;
};

const refused = (): PostResult => ({ ok: false, code: "ROOM_REPLY_REFUSED", error: "Fixture provider refusal" });

/** Opt-in fixture for the room transport. Existing MockDriver scenarios keep
 * their original dispatch path. This never opens a browser or provider. */
export class MockRoomReplyDriver extends MockDriver {
  readonly roomParents = new Map<string, { memberUrn: string; own?: boolean }>();
  readonly roomWrites: RoomReplyInput[] = [];
  readonly roomReceipts = new Map<string, RoomReceipt>();
  roomOutcome: "confirmed" | "uncertain" | "failed" = "confirmed";

  private roomKey(input: RoomReplyInput) {
    return `${input.postUrn}:${input.commentId}`;
  }

  private fingerprint(input: RoomReplyInput) {
    return createHash("sha256").update(JSON.stringify(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
  }

  private receipt(input: RoomReplyInput) {
    if (input.expectedAccountProfileId !== this.signedInAs) throw new Error("ACCOUNT_CHANGED");
    const receipt = this.roomReceipts.get(input.marker);
    if (receipt && receipt.fingerprint !== this.fingerprint(input)) throw new Error("OPERATION_CONFLICT");
    return receipt;
  }

  async postWithReceipt(input: PostInput | RoomReplyInput): Promise<PostResult> {
    if (input.kind === "comment") return this.postComment(input.postUrn, input.text);
    if (input.kind === "reply") return this.postReply(input, input.text);
    if (input.expectedAccountProfileId !== this.signedInAs) return { ok: false, notAttempted: true, code: "ACCOUNT_CHANGED", error: "ACCOUNT_CHANGED" };
    const prior = this.receipt(input);
    if (prior && !prior.released) {
      if (prior.result.state === "failed") return refused();
      if (prior.result.state !== "confirmed") throw new Error("WRITE_OUTCOME_UNCERTAIN");
      return { ok: true, externalUrn: prior.result.externalUrn };
    }
    const parent = this.roomParents.get(this.roomKey(input));
    const code = !parent ? "ROOM_TARGET_MOVED" : parent.own ? "ROOM_ALREADY_OURS"
      : parent.memberUrn !== input.expectedAuthorMemberUrn ? "ROOM_AUTHOR_CHANGED" : null;
    if (code) return { ok: false, notAttempted: true, code, error: code };
    this.roomWrites.push({ ...input });
    const result: RoomReceipt["result"] = this.roomOutcome === "confirmed"
      ? { state: "confirmed", externalUrn: `urn:li:comment:mock-room-${this.roomWrites.length}` }
      : { state: this.roomOutcome };
    this.roomReceipts.set(input.marker, { fingerprint: this.fingerprint(input), result, released: false, version: prior?.version ?? -1 });
    if (result.state === "failed") return refused();
    if (result.state !== "confirmed") throw new Error("WRITE_OUTCOME_UNCERTAIN");
    return { ok: true, externalUrn: result.externalUrn };
  }

  override async reconcilePosted(input: PostInput | RoomReplyInput): Promise<string | null> {
    if (input.kind !== "room_reply") return super.reconcilePosted(input);
    const receipt = this.receipt(input);
    if (!receipt || receipt.released || receipt.result.state === "absent" || receipt.result.state === "failed") return null;
    if (receipt.result.state !== "confirmed") throw new Error("THREAD_INCOMPLETE");
    return receipt.result.externalUrn;
  }

  async resolveUncertainWriteOutcome(input: PostInput | RoomReplyInput, resolutionVersion: number): Promise<WriteOutcomeResolutionResult> {
    if (input.kind !== "room_reply") throw new Error("unsupported_operation");
    if (!Number.isInteger(resolutionVersion) || resolutionVersion < 0) throw new Error("INVALID_REQUEST");
    const receipt = this.receipt(input);
    if (!receipt || receipt.result.state === "uncertain") throw new Error("THREAD_INCOMPLETE");
    if (receipt.result.state === "failed") throw new Error("WRITE_NOT_UNCERTAIN");
    if (receipt.result.state === "confirmed") return { operationId: input.marker, state: "already_committed", resolutionVersion, externalUrn: receipt.result.externalUrn };
    if (resolutionVersion < receipt.version || (resolutionVersion === receipt.version && !receipt.released)) throw new Error("STALE_RESOLUTION");
    receipt.released = true;
    receipt.version = resolutionVersion;
    return { operationId: input.marker, state: "resolved_not_posted", resolutionVersion };
  }
}
