// Usage: node build.mjs <docsDir> <htmlOutDir>
// Renders each docs/*.md (plus a combined book) to print-ready HTML with Mermaid diagrams.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Marked } from 'marked'

const [docsDir, outDir] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })
const mermaidSrc = pathToFileURL(resolve('node_modules/mermaid/dist/mermaid.min.js')).href

const files = readdirSync(docsDir).filter((f) => /^0\d-.*\.md$/.test(f)).sort()

function makeMarked(linkMode) {
  const m = new Marked({ gfm: true })
  m.use({
    renderer: {
      code({ text, lang }) {
        if (lang === 'mermaid') return `<div class="diagram"><pre class="mermaid">${escapeHtml(text)}</pre></div>`
        return `<pre><code>${escapeHtml(text)}</code></pre>`
      },
      link({ href, text }) {
        let h = href
        const md = /^(0\d-[^#]+)\.md(#.*)?$/.exec(href)
        if (md) h = linkMode === 'book' ? `#${md[1]}` : `${md[1]}.pdf${md[2] ?? ''}`
        else if (/^README\.md$/.test(href)) h = linkMode === 'book' ? '#top' : 'ASTRA-HEALTH-Design-Docs.pdf'
        return `<a href="${h}">${text}</a>`
      },
    },
  })
  return m
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const css = `
@page { size: A4; margin: 16mm 14mm 18mm 14mm;
  @bottom-center { content: "ASTRA HEALTH · page " counter(page) " of " counter(pages); font: 8pt 'Segoe UI', sans-serif; color: #64748b; } }
* { box-sizing: border-box; }
body { font: 10pt/1.5 'Segoe UI', 'Inter', Arial, sans-serif; color: #0f172a; margin: 0; }
h1 { font-size: 20pt; color: #0b3b66; border-bottom: 3px solid #38bdf8; padding-bottom: 6px; margin: 0 0 10px; }
h2 { font-size: 14pt; color: #0b3b66; margin: 22px 0 8px; border-bottom: 1px solid #cbd5e1; padding-bottom: 3px; break-after: avoid; }
h3 { font-size: 11.5pt; color: #1e3a5f; margin: 16px 0 6px; break-after: avoid; }
h4 { font-size: 10.5pt; margin: 12px 0 4px; break-after: avoid; }
p, li { orphans: 3; widows: 3; }
a { color: #0369a1; text-decoration: none; }
code { font-family: 'Cascadia Mono', Consolas, monospace; font-size: 8.6pt; background: #f1f5f9; padding: 0 3px; border-radius: 3px; }
pre { background: #0f172a; color: #e2e8f0; padding: 9px 11px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; font-size: 8.3pt; line-height: 1.4; break-inside: avoid; }
pre code { background: none; color: inherit; padding: 0; font-size: inherit; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 12px; font-size: 8.6pt; }
thead { display: table-header-group; }
th { background: #0b3b66; color: #fff; text-align: left; padding: 5px 6px; }
td { border: 1px solid #cbd5e1; padding: 4px 6px; vertical-align: top; }
tr:nth-child(even) td { background: #f8fafc; }
tr { break-inside: avoid; }
blockquote { margin: 10px 0; padding: 8px 12px; background: #fff7ed; border-left: 4px solid #f59e0b; border-radius: 4px; }
blockquote p { margin: 4px 0; }
.diagram { break-inside: avoid; margin: 10px 0; text-align: center; }
.diagram pre.mermaid { background: none; color: inherit; padding: 0; }
.diagram svg { max-width: 100% !important; height: auto; }
.cover { background: linear-gradient(135deg, #0b1020, #12305a); color: #e6ecff; padding: 22px 24px; border-radius: 10px; margin-bottom: 18px; }
.cover .brand { font-size: 22pt; font-weight: 700; letter-spacing: 4px; color: #38bdf8; }
.cover .sub { font-size: 9pt; letter-spacing: 3px; text-transform: uppercase; color: #94a3c4; }
.cover .doc { font-size: 15pt; margin-top: 10px; }
.cover .meta { font-size: 8.5pt; color: #94a3c4; margin-top: 6px; }
.docsep { break-before: page; }
input[type=checkbox] { margin-right: 4px; }
`

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${css}</style>
<script src="${mermaidSrc}"></script></head><body id="top">${body}
<script>
mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose',
  flowchart: { useMaxWidth: true, htmlLabels: true }, sequence: { useMaxWidth: true }, gantt: { useMaxWidth: true } });
(async () => {
  // Render one diagram at a time: parallel rendering makes sequence diagrams overlap.
  const nodes = [...document.querySelectorAll('pre.mermaid')];
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    try {
      const { svg } = await mermaid.render('dgm' + i, el.textContent);
      const holder = document.createElement('div');
      holder.innerHTML = svg;
      el.replaceWith(holder);
    } catch (e) {
      el.insertAdjacentHTML('afterend', '<p style="color:red">Diagram error: ' + e + '</p>');
    }
  }
  document.body.dataset.ready = '1';
})();
</script></body></html>`
}

function cover(docTitle) {
  return `<div class="cover"><div class="brand">ASTRA HEALTH</div><div class="sub">Autonomous Astronaut Health Intelligence &amp; Decision Support</div>
<div class="doc">${docTitle}</div><div class="meta">Version 1.0 · 14 Nov 2026 · Hackathon prototype — not a medical device</div></div>`
}

const titles = {}
let book = cover('Design Documentation — complete set') + makeMarked('book').parse(readFileSync(join(docsDir, 'README.md'), 'utf8'))

for (const f of files) {
  const md = readFileSync(join(docsDir, f), 'utf8')
  const base = f.replace(/\.md$/, '')
  const title = (/^# (.+)$/m.exec(md)?.[1] ?? base).replace(/^ASTRA HEALTH — /, '')
  titles[base] = title
  writeFileSync(join(outDir, `${base}.html`), page(title, cover(title) + makeMarked('file').parse(md)))
  book += `<section class="docsep" id="${base}">${makeMarked('book').parse(md)}</section>`
}
writeFileSync(join(outDir, 'ASTRA-HEALTH-Design-Docs.html'), page('ASTRA HEALTH Design Docs', book))
console.log(JSON.stringify(titles, null, 1))
