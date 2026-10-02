import assert from 'node:assert/strict';
import { readFile, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'parse5';
import { buildSite, attribute, walk } from './build.mjs';
import { chooseLanguage } from './locale.mjs';

// Verify the emitted crawlable pages, not just the source template.
const outputDirectory = await mkdtemp(path.join(tmpdir(), 'codexauth-site-check-'));
const env = { CF_PAGES: process.env.CF_PAGES, CF_PAGES_BRANCH: process.env.CF_PAGES_BRANCH };
try {
  delete process.env.CF_PAGES;
  delete process.env.CF_PAGES_BRANCH;
  const built = await buildSite({ outputDirectory });
  const expected = { zh: `${built.siteUrl}/zh/`, en: `${built.siteUrl}/en/`, 'x-default': `${built.siteUrl}/` };
  const headers = await readFile(path.join(outputDirectory, '_headers'), 'utf8');
  assert(!headers.includes('X-Robots-Tag: noindex'), 'Production must be indexable');
  for (const [language, file] of [['zh', 'zh/index.html'], ['en', 'en/index.html'], ['entry', 'index.html']]) {
    const html = await readFile(path.join(outputDirectory, file), 'utf8');
    const doc = parse(html);
    const nodes = [];
    walk(doc, node => nodes.push(node));
    const ids = nodes.map(node => attribute(node, 'id')).filter(Boolean);
    assert.equal(ids.length, new Set(ids).size, `${file}: duplicate IDs`);
    assert.equal(nodes.filter(node => node.tagName === 'h1').length, 1, `${file}: one H1`);
    const canonical = nodes.filter(node => attribute(node, 'rel') === 'canonical');
    assert.equal(canonical.length, 1);
    assert.equal(attribute(canonical[0], 'href'), expected[language === 'entry' ? 'x-default' : language]);
    const alternates = nodes.filter(node => attribute(node, 'rel') === 'alternate');
    assert.deepEqual(Object.fromEntries(alternates.map(node => [attribute(node, 'hreflang'), attribute(node, 'href')])), expected);
    const description = nodes.find(node => attribute(node, 'name') === 'description');
    assert(attribute(description, 'content').length > 50, `${file}: substantive description`);
    assert.equal(attribute(nodes.find(node => attribute(node, 'name') === 'robots'), 'content'), 'index, follow, max-image-preview:large');
    const schemaNode = nodes.find(node => attribute(node, 'type') === 'application/ld+json');
    const schemaText = schemaNode.childNodes[0].value;
    const graph = JSON.parse(schemaText)['@graph'];
    const schemaHash = `sha256-${createHash('sha256').update(schemaText).digest('base64')}`;
    assert(headers.includes(schemaHash), `${file}: JSON-LD permitted by CSP`);
    if (language !== 'entry') {
      assert.equal(attribute(nodes.find(node => node.tagName === 'html'), 'lang'), language === 'zh' ? 'zh-CN' : 'en');
      const faq = graph.find(node => node['@type'] === 'FAQPage');
      assert.equal(faq.mainEntity.length, 5);
      assert(faq.mainEntity.every(item => item.name && item.acceptedAnswer.text));
      const software = graph.find(node => node['@type'] === 'SoftwareApplication');
      assert.equal(software.offers.price, 0);
      assert(!software.aggregateRating, 'Do not invent review data');
      assert(!html.includes('/entry.mjs'), 'Localized pages must not auto-redirect');
      if (language === 'en') {
        const visibleText = nodes.filter(node => node.nodeName === '#text' && node.parentNode?.tagName !== 'script').map(node => node.value).join('');
        assert(!/[\u4e00-\u9fff]/.test(visibleText.replaceAll('中文', '')), 'English page must be translated before JavaScript runs');
      }
    }
    for (const node of nodes) {
      for (const name of ['src', 'href']) {
        const value = attribute(node, name);
        if (!value) continue;
        if (value.startsWith('#') && value.length > 1) assert(ids.includes(value.slice(1)), `${file}: broken anchor ${value}`);
        if (value.startsWith('/') && !value.startsWith('//') && !['/', '/en/', '/zh/'].includes(value)) {
          assert((await stat(path.join(outputDirectory, value))).isFile(), `${file}: missing asset ${value}`);
        }
      }
    }
  }
  const sitemap = await readFile(path.join(outputDirectory, 'sitemap.xml'), 'utf8');
  assert.equal((sitemap.match(/<loc>/g) || []).length, 3);
  for (const url of Object.values(expected)) assert(sitemap.includes(`<loc>${url}</loc>`));
  assert((await readFile(path.join(outputDirectory, 'robots.txt'), 'utf8')).includes(`Sitemap: ${built.siteUrl}/sitemap.xml`));
  process.env.CF_PAGES = '1';
  process.env.CF_PAGES_BRANCH = 'preview-seo-check';
  await buildSite({ outputDirectory });
  assert((await readFile(path.join(outputDirectory, 'robots.txt'), 'utf8')).includes('Disallow: /'));
  assert((await readFile(path.join(outputDirectory, '_headers'), 'utf8')).includes('X-Robots-Tag: noindex, nofollow'));
  assert((await readFile(path.join(outputDirectory, 'en/index.html'), 'utf8')).includes('content="noindex, nofollow"'));
  for (const [saved, device, expectedLanguage] of [
    ['en', ['zh-CN'], 'en'], ['zh', ['en-US'], 'zh'], [null, ['zh-TW'], 'zh'],
    [null, ['en-GB', 'zh-CN'], 'en'], [null, ['fr-FR', 'zh-Hans'], 'zh'],
    ['invalid', ['zh_CN'], 'zh'], [null, ['de-DE'], 'en'], [null, [], 'en'],
  ]) assert.equal(chooseLanguage(saved, device), expectedLanguage);
  console.log('PASS: static Chinese/English, metadata, canonical/hreflang, JSON-LD/CSP, links/assets, sitemap, preview noindex, language preferences.');
} finally {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
