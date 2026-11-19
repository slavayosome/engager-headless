/**
 * The one money formatter. Stripe reports an amount in the currency's minor
 * unit, and how many decimals that unit has is the currency's, not ours: USD
 * 1500 is $15, JPY 1500 is ¥1,500 and KWD 1234 is KWD 1.234. The exponent
 * comes from `Intl`, so no caller divides by a literal 100.
 *
 * Whole amounts carry no decimals ("$15"); any other keeps the currency's full
 * precision ("$15.50"). Pure and dependency-free, so a client component, an
 * email and a server page print exactly the same figure.
 */
export function formatMoney(
  minorUnits: number,
  currency: string,
  locale = "en-US",
): string {
  const code = currency.toUpperCase();
  const exponent = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: code,
  }).resolvedOptions().maximumFractionDigits!;
  const unit = 10 ** exponent;
  const digits = minorUnits % unit === 0 ? 0 : exponent;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: code,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(minorUnits / unit);
}
