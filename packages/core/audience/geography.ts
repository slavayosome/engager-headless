import { z } from "zod";

/**
 * Where an Audience's people are: the countries it keeps, the countries it
 * never keeps, and what a person whose profile names no country counts as.
 *
 * A country is only ever what a LinkedIn profile's location says — its ISO
 * code, read by Research. A profile's locale is the language it is written
 * in, and a name or a photo is not a place, so neither is ever read as one.
 */

/** ISO 3166-1 alpha-2, and XK, which LinkedIn's location data uses for
 *  Kosovo. */
export const COUNTRY_CODES = [
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ",
  "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS",
  "BT", "BV", "BW", "BY", "BZ", "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN",
  "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE",
  "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF",
  "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK", "HM",
  "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT", "JE", "JM",
  "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC",
  "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK",
  "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA",
  "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG",
  "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU", "RW",
  "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS",
  "ST", "SV", "SX", "SY", "SZ", "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO",
  "TR", "TT", "TV", "TW", "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI",
  "VN", "VU", "WF", "WS", "XK", "YE", "YT", "ZA", "ZM", "ZW",
] as const;

const KNOWN: ReadonlySet<string> = new Set(COUNTRY_CODES);

export function isCountryCode(value: string): boolean {
  return KNOWN.has(value);
}

const NAMES = new Intl.DisplayNames(["en"], { type: "region" });

/** The country's English name, or its code where the runtime has none. */
export function countryName(code: string): string {
  return NAMES.of(code) ?? code;
}

const EU = [
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT",
  "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
] as const;

/**
 * Shortcuts the owner picks countries with. Picking one adds its countries;
 * the Audience stores the countries, never the region, so a region is only
 * ever a way to type them — and a region an owner already used never shrinks,
 * so North America keeps Mexico.
 */
export const REGIONS = [
  {
    id: "africa",
    label: "Africa",
    countries: [
      "AO", "BF", "BI", "BJ", "BW", "CD", "CF", "CG", "CI", "CM", "CV", "DJ", "DZ", "EG", "EH", "ER",
      "ET", "GA", "GH", "GM", "GN", "GQ", "GW", "KE", "KM", "LR", "LS", "LY", "MA", "MG", "ML", "MR",
      "MU", "MW", "MZ", "NA", "NE", "NG", "RE", "RW", "SC", "SD", "SH", "SL", "SN", "SO", "SS", "ST",
      "SZ", "TD", "TG", "TN", "TZ", "UG", "YT", "ZA", "ZM", "ZW",
    ],
  },
  { id: "eu", label: "European Union", countries: [...EU] },
  {
    id: "europe",
    label: "Europe",
    countries: [
      ...EU, "AD", "AL", "AX", "BA", "BY", "CH", "FO", "GB", "GG", "GI", "IM", "IS", "JE", "LI", "MC",
      "MD", "ME", "MK", "NO", "RS", "RU", "SJ", "SM", "UA", "VA", "XK",
    ],
  },
  { id: "uk_ireland", label: "UK & Ireland", countries: ["GB", "IE"] },
  { id: "dach", label: "DACH", countries: ["DE", "AT", "CH"] },
  { id: "nordics", label: "Nordics", countries: ["SE", "NO", "DK", "FI"] },
  { id: "benelux", label: "Benelux", countries: ["BE", "NL", "LU"] },
  {
    id: "middle_east",
    label: "Middle East",
    countries: ["AE", "BH", "CY", "EG", "IL", "IQ", "IR", "JO", "KW", "LB", "OM", "PS", "QA", "SA", "SY", "TR", "YE"],
  },
  { id: "south_asia", label: "South Asia", countries: ["AF", "BD", "BT", "IN", "LK", "MV", "NP", "PK"] },
  { id: "southeast_asia", label: "Southeast Asia", countries: ["BN", "ID", "KH", "LA", "MM", "MY", "PH", "SG", "TH", "TL", "VN"] },
  { id: "east_asia", label: "East Asia", countries: ["CN", "HK", "JP", "KP", "KR", "MN", "MO", "TW"] },
  { id: "north_america", label: "North America", countries: ["CA", "MX", "US"] },
  {
    id: "latin_america",
    label: "Latin America",
    countries: ["AR", "BO", "BR", "CL", "CO", "CR", "CU", "DO", "EC", "GT", "HN", "MX", "NI", "PA", "PE", "PR", "PY", "SV", "UY", "VE"],
  },
  {
    id: "oceania",
    label: "Oceania",
    countries: ["AU", "CK", "FJ", "FM", "KI", "MH", "NC", "NR", "NU", "NZ", "PF", "PG", "PW", "SB", "TO", "TV", "VU", "WS"],
  },
] as const satisfies ReadonlyArray<{ id: string; label: string; countries: readonly (typeof COUNTRY_CODES)[number][] }>;

/** What a person whose profile names no country counts as. */
export const UNKNOWN_COUNTRY = ["count_in", "owner_call", "leave_out"] as const;
export type UnknownCountry = (typeof UNKNOWN_COUNTRY)[number];

const countries = z
  .array(z.string().trim().toUpperCase().refine(isCountryCode, "Use a two-letter country code, such as IN."))
  .transform((codes) => [...new Set(codes)].sort());

export const audienceWhereSchema = z.object({
  /** When non-empty, only people in these countries. */
  includeCountries: countries.default([]),
  /** Never people in these countries, whatever the list above says. */
  excludeCountries: countries.default([]),
  unknownCountry: z.enum(UNKNOWN_COUNTRY).default("count_in"),
}).strict();
export type AudienceWhere = z.infer<typeof audienceWhereSchema>;

export const ANYWHERE: AudienceWhere = { includeCountries: [], excludeCountries: [], unknownCountry: "count_in" };

/** Whether the Audience names any country. With none, nobody's country is
 *  read or judged, whatever counts an unknown one. */
export function placesBind(where: AudienceWhere): boolean {
  return where.includeCountries.length > 0 || where.excludeCountries.length > 0;
}

/**
 * Where a person stands against the Audience's countries: `in`, `out` with
 * the owner's words for it, or `unknown` — no country was read, or the
 * profile named none. `anywhere` when the Audience names no country.
 */
export function placeCountry(
  country: string | null | undefined,
  where: AudienceWhere,
): { place: "anywhere" | "in" | "unknown" } | { place: "out"; reason: string } {
  if (!placesBind(where)) return { place: "anywhere" };
  if (!country) return { place: "unknown" };
  const code = country.toUpperCase();
  if (where.excludeCountries.includes(code) ||
      (where.includeCountries.length > 0 && !where.includeCountries.includes(code))) {
    return { place: "out", reason: `Outside your countries · ${code}` };
  }
  return { place: "in" };
}

export const COUNTRY_UNKNOWN_REASON = "Country unknown";
