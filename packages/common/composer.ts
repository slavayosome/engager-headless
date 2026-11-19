/**
 * The most angles one box the owner writes in holds. The server enforces it
 * (`core/composer/drafts.ts`) and the dashboard's composer turns More angles
 * off at it, so both read it here: a module with no imports, which the browser
 * can take where `drafts.ts` pulls in the database.
 */
export const COMPOSER_ANGLE_LIMIT = 5;
