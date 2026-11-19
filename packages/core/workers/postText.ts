/** The verified full read when available, otherwise the discovered preview. */
export function draftingPostText(post: { contentText: string | null }, fullText?: string | null): string {
  return fullText || post.contentText || "";
}
