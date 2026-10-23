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

export const VPN_PARTNER = {
  name: 'PureVPN',
  url: 'https://billing.purevpn.com/aff.php?aff=49387845',
  title: 'Bypass ISP Censorship & Unblock Every Site',
  description: '6,500+ high-speed servers in 70+ countries. Zero logs, P2P allowed, unblock all manga & anime mirrors with 31-day money-back guarantee.',
  badge: 'Recommended VPN'
};

export const PCLOUD_PARTNER = {
  name: 'pCloud',
  url: 'https://partner.pcloud.com/r/156786',
  passUrl: 'https://partner.pcloud.com/r/156784',
  businessUrl: 'https://partner.pcloud.com/r/156781',
  title: '10TB Lifetime Cloud Storage — Pay Once, Keep Forever',
  description: 'Store entire uncensored doujin & anime libraries safely with Swiss zero-knowledge privacy. No recurring monthly subscriptions.',
  badge: 'Lifetime Deal'
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
