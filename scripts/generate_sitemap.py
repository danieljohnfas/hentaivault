"""
generate_sitemap.py — Auto-generates sitemap.xml from js/data.js with hreflang for 8 languages.
Run from vault root directory whenever data.js changes.
"""
import re
import json
import os
from datetime import date

# Use the script's own location to build relative paths — works on both Windows and Linux (GitHub Actions)
VAULT_DIR  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_FILE  = os.path.join(VAULT_DIR, "js", "data.js")
SITEMAP_FILE = os.path.join(VAULT_DIR, "sitemap.xml")
BASE_URL   = "https://hentaivault.me"
TODAY      = date.today().isoformat()

LANGUAGES = ['en', 'es', 'ja', 'fr', 'pt', 'hi', 'ar', 'de']
LANG_PARAM_MAP = {
    'en': None,       # no param = default
    'es': 'es',
    'ja': 'jp',       # internal key is 'jp' (legacy)
    'fr': 'fr',
    'pt': 'pt',
    'hi': 'hi',
    'ar': 'ar',
    'de': 'de',
}

def build_hreflang_links(url):
    lines = []
    for hreflang, param in LANG_PARAM_MAP.items():
        if param is None:
            href = url
        else:
            sep = '&amp;' if '?' in url else '?'
            href = f"{url}{sep}lang={param}"
        lines.append(f'    <xhtml:link rel="alternate" hreflang="{hreflang}" href="{href}"/>')
    # x-default always points to canonical (no lang param)
    lines.append(f'    <xhtml:link rel="alternate" hreflang="x-default" href="{url}"/>')
    return '\n'.join(lines)

def make_url_block(loc, changefreq, priority, include_hreflang=True):
    hreflang = build_hreflang_links(loc) if include_hreflang else ''
    hreflang_block = f'\n{hreflang}' if hreflang else ''
    return f"""  <url>
    <loc>{loc}</loc>
    <lastmod>{TODAY}</lastmod>
    <changefreq>{changefreq}</changefreq>
    <priority>{priority}</priority>{hreflang_block}
  </url>"""

def load_site_ids():
    with open(DATA_FILE, 'r', encoding='utf-8') as f:
        content = f.read()
    match = re.search(r'const\s+sitesData\s*=\s*([\s\S]*?\]);', content)
    if not match:
        print("ERROR: Could not parse sitesData from data.js")
        return []
    json_str = match.group(1)
    json_str = re.sub(r',\s*([}\]])', r'\1', json_str)
    sites = json.loads(json_str)
    return [s['id'] for s in sites if s.get('id')]

def generate():
    print("Generating sitemap.xml...")

    # Static pages
    static_pages = [
        (f"{BASE_URL}/",                             "daily",   "1.0"),
        (f"{BASE_URL}/blog",                         "weekly",  "0.7"),
        (f"{BASE_URL}/about",                        "monthly", "0.5"),
        (f"{BASE_URL}/contact",                      "monthly", "0.5"),
        (f"{BASE_URL}/privacy",                      "monthly", "0.3"),
        (f"{BASE_URL}/terms",                        "monthly", "0.3"),
        (f"{BASE_URL}/disclaimer",                   "monthly", "0.3"),
        (f"{BASE_URL}/dmca",                         "monthly", "0.3"),
    ]

    # Category pages
    categories = [
        "anime-streaming", "hentai-streaming", "manga-doujin",
        "images-boorus", "games", "communities", "downloads",
        "visual-novels", "adult-studios", "adult-vr", "premium-creators",
    ]

    # Blog posts
    blog_posts = [
        "nhentai-alternatives-2026",
        "hanime-alternatives-2026",
        "privacy-safety-guide",
        "best-doujin-sites-2026",
        "free-manga-guide",
        "best-streaming-2026",
        "hentai-apps-guide-2026",
        "top-10-sites-may-2026",
        "uncensored-streaming-guide-2026",
    ]

    lines = ['<?xml version="1.0" encoding="UTF-8"?>']
    lines.append('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"')
    lines.append('        xmlns:xhtml="http://www.w3.org/1999/xhtml">')

    # Static pages (with hreflang)
    for loc, freq, priority in static_pages:
        lines.append(make_url_block(loc, freq, priority, include_hreflang=True))

    # Category pages (with hreflang)
    for cat in categories:
        loc = f"{BASE_URL}/category/{cat}"
        lines.append(make_url_block(loc, "daily", "0.8", include_hreflang=True))

    # Blog posts (with hreflang)
    for post in blog_posts:
        loc = f"{BASE_URL}/blog/{post}"
        lines.append(make_url_block(loc, "monthly", "0.8", include_hreflang=True))

    # Site review pages (with hreflang)
    site_ids = load_site_ids()
    print(f"  Found {len(site_ids)} site entries in data.js")
    for sid in site_ids:
        loc = f"{BASE_URL}/site?id={sid}"
        lines.append(make_url_block(loc, "weekly", "0.6", include_hreflang=True))

    lines.append('</urlset>')

    sitemap_content = '\n'.join(lines)
    with open(SITEMAP_FILE, 'w', encoding='utf-8') as f:
        f.write(sitemap_content)

    total_urls = len(static_pages) + len(categories) + len(blog_posts) + len(site_ids)
    print(f"  sitemap.xml generated: {total_urls} URLs, each with hreflang for {len(LANGUAGES)} languages")
    print(f"  Saved to: {SITEMAP_FILE}")

if __name__ == "__main__":
    generate()
