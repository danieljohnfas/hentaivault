/**
 * Affiliate links for listed sites.
 *
 * When a listed site runs an affiliate programme you have joined, add its domain (without
 * "www.") and the tracking link the programme gives you. Every "Visit" button for that site
 * (directory cards, site pages and /out) then uses the affiliate link instead of the plain URL.
 * Domains not listed here keep their normal links. The disclaimer page discloses this.
 *
 * Example:
 *   'example-games.com': 'https://www.example-games.com/?ref=YOUR_AFFILIATE_ID',
 */
export const AFFILIATE_LINKS = {
};

export function affiliateUrlFor(siteUrl) {
  try {
    const host = new URL(siteUrl).hostname.toLowerCase().replace(/^www\./, '');
    const link = AFFILIATE_LINKS[host];
    return typeof link === 'string' && link.startsWith('https://') ? link : null;
  } catch {
    return null;
  }
}
