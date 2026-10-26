# HentaiVault — Coding Agent Operational Guide

This document is the authoritative contract for all AI coding agents working on HentaiVault.

---

## 1. Runtime & Stack Invariants

- **Hosting & Infrastructure:** Static HTML + Cloudflare Pages & Workers.
- **Data Model & Directory:** Over 2,000+ curated directory entries, category taxonomies, and creator profiles.
- **SEO & Discoverability Invariants:**
  - Preserve all schema.org structured data (`BreadcrumbList`, `ItemList`, `SoftwareApplication`).
  - Keep sitemaps synchronized (`sitemap-index.xml`, `sitemap-main.xml`, `sitemap-categories.xml`).
  - Maintain `llms.txt` and `robots.txt` integrity.
- **Link & Affiliate Integrity:**
  - Outbound creator URLs, affiliate trackers, and partner parameters must never be modified or truncated without explicit instruction.
  - New submissions must pass safety policy screening (Mistral Shieldstral 1.0).

---

## 2. Golden Verification Commands

```bash
# Check for orphaned category pages or broken taxonomy links
python check_orphans.py

# Verify local live preview
npx wrangler pages dev .

# Deploy to Cloudflare Pages
npx wrangler pages deploy .
```

---

## 3. Architecture & Forbidden Zones

- `category/`: Topic and genre hubs.
- `blog/`: Static editorial and research articles.
- `scripts/`: Maintenance, deadlink screening, and data enrichment scripts.
- `reports/`: Audit logs and telemetry (kept out of public site via `.assetsignore`).
- **Forbidden:**
  - NEVER commit Google Search Console service account credentials (`gsc-credentials.json`).
  - NEVER delete or bulk-prune site records without generating an idempotent rollback SQL or backup.

---

## 4. 🛑 The YAGNI Rule (You Ain't Gonna Need It)

1. **No Speculative Code:** Implement only requested fixes, category enrichments, or link audits. Do not build unrequested CMS backends or client-side application frameworks.
2. **No Unsolicited Refactoring:** Do not reformat existing static HTML files, banner placements, or CSS stylesheets unless requested.
3. **Zero Unnecessary Dependencies:** Keep client pages 100% vanilla HTML/CSS/JS for instant sub-second global CDN loading.
4. **Surgical, Minimal Diffs:** Make precise, targeted edits.

---

## 5. Definition of Done

Before completing any task:
- [ ] `python check_orphans.py` passes with no broken references.
- [ ] Page renders cleanly in browser without console errors.
- [ ] No API keys, credentials, or service account secrets are exposed.
