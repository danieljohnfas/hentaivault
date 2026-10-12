const fs = require('fs');
const path = require('path');

function walk(dir, results = []) {
  const SKIP = ['node_modules', '.git', 'scripts', 'assets', 'css', 'js', '.wrangler', '.github', 'migrations', 'bot'];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP.includes(entry.name)) continue;
      walk(full, results);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      results.push(full);
    }
  }
  return results;
}

const files = walk('.');
const report = {
  totalFiles: files.length,
  missingFooter: [],
  adNetworkCode: [],
  seoIssues: []
};

// The site carries no display-ad networks; flag any page where their code reappears.
const AD_NETWORK_MARKERS = [
  'adsterra', 'highperformanceformat', 'profitablecpmratenetwork', 'effectivegatecpm',
  'atOptions', 'purevpn', 'puresquare'
];

for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');

  if (!html.includes('<footer')) report.missingFooter.push(file);

  const lower = html.toLowerCase();
  for (const marker of AD_NETWORK_MARKERS) {
    if (lower.includes(marker.toLowerCase())) {
      report.adNetworkCode.push(`${file} (${marker})`);
    }
  }

  // Basic SEO check for blog pages
  if (file.includes('blog\\') || file.includes('blog/')) {
    if (!html.includes('<h1')) report.seoIssues.push(`${file} (Missing H1)`);
    if (!html.includes('<meta name="description"')) report.seoIssues.push(`${file} (Missing meta description)`);
  }
}

fs.writeFileSync('audit_report.json', JSON.stringify(report, null, 2));
console.log(`Audit complete. Ad network code found on ${report.adNetworkCode.length} page(s).`);
if (report.adNetworkCode.length > 0) process.exitCode = 1;
