/** Shared by the server's write guard and the inline search form. */
export const MAX_SEARCH_ORS = 3;
const OR_OPERATOR = /(?<![\p{L}\p{N}])OR(?![\p{L}\p{N}])/gu;

/** LinkedIn operators are capitals outside quoted phrases. */
export function countOrs(term: string): number {
  return term.split('"').filter((_, index) => index % 2 === 0)
    .reduce((count, unquoted) => count + (unquoted.match(OR_OPERATOR)?.length ?? 0), 0);
}
