import { readFile, writeFile, mkdir, cp, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, parseFragment, serialize } from 'parse5';

const source = path.dirname(fileURLToPath(import.meta.url));
const repository = 'https://github.com/GboyCode/CodexAuth';
export const attribute = (node, name) => node.attrs?.find(item => item.name === name)?.value;
export function walk(node, visit) {
  visit(node);
  for (const child of [...(node.childNodes || [])]) walk(child, visit);
}
export function findNode(root, predicate) {
  let found;
  walk(root, node => { if (!found && predicate(node)) found = node; });
  return found;
}
function setAttribute(node, name, value) {
  const existing = node.attrs.find(item => item.name === name);
  if (existing) existing.value = value;
  else node.attrs.push({name, value});
}
function setHtml(node, html) {
  node.childNodes = parseFragment(html).childNodes;
  for (const child of node.childNodes) child.parentNode = node;
}
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const plainText = node => node.nodeName === '#text' ? node.value : (node.childNodes || []).map(plainText).join('');

export async function buildSite({preview = false, outputDirectory = path.join(source, 'dist')} = {}) {
  const config = JSON.parse(await readFile(path.join(source, 'site.config.json'), 'utf8'));
  const origin = new URL(process.env.SITE_URL || config.siteUrl);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password || !origin.hostname.includes('.') || /^(localhost|127\.)/.test(origin.hostname)) throw new Error('SITE_URL must be the final public HTTPS origin, without a path.');
  const siteUrl = origin.origin;
  const isPreview = preview || (process.env.CF_PAGES === '1' && process.env.CF_PAGES_BRANCH !== config.productionBranch);
  const template = await readFile(path.join(source, 'index.html'), 'utf8');
  const contentFile = path.join(source, 'content.mjs');
  const {translations, messages} = await import(`${pathToFileURL(contentFile)}?mtime=${(await stat(contentFile)).mtimeMs}`);
  const alternates = [['zh', `${siteUrl}/zh/`], ['en', `${siteUrl}/en/`], ['x-default', `${siteUrl}/`]];
  const languageLinks = alternates.map(([language, url]) => `<link rel="alternate" hreflang="${language}" href="${escape(url)}">`).join('\n');
  const hashes = new Set();
  const robots = isPreview ? 'noindex, nofollow' : 'index, follow, max-image-preview:large';
  const schemaScript = graph => {
    const json = JSON.stringify({'@context':'https://schema.org','@graph':graph}).replace(/</g, '\\u003c');
    hashes.add(`'sha256-${createHash('sha256').update(json).digest('base64')}'`);
    return `<script type="application/ld+json">${json}</script>`;
  };
  const websiteSchema = {'@type':'WebSite','@id':`${siteUrl}/#website`,url:`${siteUrl}/`,name:'CodexAuth Switch',alternateName:'CodexAuth',inLanguage:['zh-CN','en'],sameAs:repository};
  const baseHead = (title, description, canonical) => `
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#f5f5f5"><meta name="robots" content="${robots}">
    <title>${escape(title)}</title><meta name="description" content="${escape(description)}">
    <link rel="canonical" href="${canonical}">${languageLinks}
    <meta property="og:type" content="website"><meta property="og:site_name" content="CodexAuth Switch">
    <meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}"><meta property="og:url" content="${canonical}">
    <meta property="og:image" content="${siteUrl}/assets/app-icon.png"><meta property="og:image:alt" content="CodexAuth Switch">
    <meta name="twitter:card" content="summary"><meta name="twitter:title" content="${escape(title)}"><meta name="twitter:description" content="${escape(description)}"><meta name="twitter:image" content="${siteUrl}/assets/app-icon.png"><meta name="twitter:image:alt" content="CodexAuth Switch">
    <link rel="icon" href="/assets/codex.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/assets/app-icon.png">
    <link rel="stylesheet" href="/assets/theme.css"><link rel="stylesheet" href="/styles.css">`;
  const generated = [];
  for (const language of ['zh','en']) {
    const doc = parse(template);
    const html = findNode(doc, node => node.tagName === 'html');
    const head = findNode(doc, node => node.tagName === 'head');
    const copy = messages[language];
    setAttribute(html, 'lang', language === 'zh' ? 'zh-CN' : 'en');
    walk(doc, node => {
      const key = attribute(node, 'data-i18n');
      if (key && !(key in translations)) throw new Error(`Missing English translation: ${key}`);
      if (language === 'en' && key) setHtml(node, translations[key]);
      for (const attr of node.attrs || []) if (['src','href'].includes(attr.name) && attr.value.startsWith('./')) attr.value = attr.value.slice(1);
    });
    const byId = id => findNode(doc, node => attribute(node, 'id') === id);
    const labels = {'demo-refresh':'refresh','widget-close':'closeWidget','demo-widget':'widgetLabel','widget-settings-toggle':'widgetSettings','widget-pin':'widgetPin','site-nav':'nav','menu-toggle':'menu','privacy-toggle':'hide'};
    for (const [id, key] of Object.entries(labels)) setAttribute(byId(id), 'aria-label', copy[key]);
    const classLabels = {'widget-quota-card':'widgetQuotas','download-platforms':'platforms'};
    for (const [className, key] of Object.entries(classLabels)) setAttribute(findNode(doc, node => attribute(node, 'class')?.split(' ').includes(className)), 'aria-label', copy[key]);
    setAttribute(findNode(doc, node => attribute(node, 'role') === 'tablist'), 'aria-label', copy.tabs);
    const brand = findNode(doc, node => attribute(node, 'class') === 'brand');
    setAttribute(brand, 'aria-label', copy.home);
    setHtml(byId('current-name'), copy.names[0]);
    setHtml(byId('demo-auto-label'), copy.autoOff);
    setAttribute(findNode(byId('demo-settings-dialog'), node => attribute(node, 'value') === 'close'), 'aria-label', copy.closeSettings);
    // Keep fictional demo addresses intact without changing zone-wide email protection.
    for (const id of ['current-email', 'widget-name']) {
      setHtml(byId(id), '<!--email_off-->studio@example.com<!--/email_off-->');
    }
    setHtml(byId('widget-quota'), `${copy.remaining}82%`);
    setHtml(byId('widget-week-quota'), `${copy.remaining}64%`);
    setHtml(byId('platform-help'), escape(copy.windows));
    const languageToggle = byId('language-toggle');
    const next = language === 'zh' ? 'en' : 'zh';
    setAttribute(languageToggle, 'href', `/${next}/`);
    setAttribute(languageToggle, 'lang', next === 'en' ? 'en' : 'zh-CN');
    setAttribute(languageToggle, 'hreflang', next);
    setAttribute(languageToggle, 'aria-label', next === 'en' ? 'Switch to English' : '切换到中文');
    setHtml(findNode(languageToggle, node => node.tagName === 'span'), next === 'en' ? 'EN' : '中文');
    const questions = [];
    const faq = byId('faq');
    walk(faq, node => {
      if (node.tagName !== 'details') return;
      questions.push({'@type':'Question',name:plainText(findNode(node, child => child.tagName === 'summary')).trim(),acceptedAnswer:{'@type':'Answer',text:plainText(findNode(node, child => attribute(child,'class') === 'faq-answer')).trim()}});
    });
    const canonical = `${siteUrl}/${language}/`;
    const softwareId = `${siteUrl}/#software`;
    const graph = [websiteSchema,
      {'@type':'WebPage','@id':`${canonical}#webpage`,url:canonical,name:copy.title,description:copy.description,inLanguage:language === 'zh' ? 'zh-CN' : 'en',isPartOf:{'@id':`${siteUrl}/#website`},mainEntity:{'@id':softwareId}},
      {'@type':'SoftwareApplication','@id':softwareId,name:'CodexAuth Switch',description:copy.description,url:canonical,operatingSystem:'Windows, macOS',applicationCategory:'DeveloperApplication',isAccessibleForFree:true,license:`${repository}/blob/main/LICENSE`,downloadUrl:`${repository}/releases/latest`,sameAs:repository,image:`${siteUrl}/assets/app-icon.png`,author:{'@type':'Person',name:'GboyCode',url:'https://github.com/GboyCode'},offers:{'@type':'Offer',price:0,priceCurrency:'USD',url:`${repository}/releases/latest`}},
      {'@type':'FAQPage','@id':`${canonical}#faq`,inLanguage:language === 'zh' ? 'zh-CN' : 'en',mainEntity:questions}
    ];
    setHtml(head, baseHead(copy.title,copy.description,canonical) + `<meta property="og:locale" content="${language === 'zh' ? 'zh_CN' : 'en_US'}"><meta property="og:locale:alternate" content="${language === 'zh' ? 'en_US' : 'zh_CN'}">` + schemaScript(graph) + '<script src="/app.js" type="module"></script>');
    generated.push([`${language}/index.html`, serialize(doc)]);
  }
  const entryTitle = 'CodexAuth Switch — Codex 多账号管理 / Account Switcher';
  const entryDescription = '免费开源的 Codex App 多账号管理工具。Free, local-first Codex account switching and quota management for Windows and macOS.';
  const entry = `<!doctype html><html lang="en"><head>${baseHead(entryTitle,entryDescription,`${siteUrl}/`)}${schemaScript([websiteSchema])}<script type="module" src="/entry.mjs"></script></head><body><main class="hero container language-entry"><a href="https://github.com/GboyCode/CodexAuth" class="brand"><img src="/assets/codex.svg" width="48" height="48" alt="">CodexAuth Switch</a><h1>Codex account switcher</h1><p class="hero-description"><span lang="zh-CN">Codex 多账号管理与自动切换，凭证保存在本机。</span><br>A local-first account switcher for Windows and macOS.</p><div class="hero-actions"><a class="button dark" href="/zh/" hreflang="zh" lang="zh-CN">中文</a><a class="button light" href="/en/" hreflang="en" lang="en">English</a></div><p class="hero-meta"><span lang="zh-CN">根据浏览器语言自动选择，也可手动进入。</span></p></main></body></html>`;
  generated.push(['index.html', entry]);
  const csp = `default-src 'self'; script-src 'self' ${[...hashes].join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  await mkdir(outputDirectory, {recursive:true});
  for (const [relative, html] of generated) {
    const destination = path.join(outputDirectory, relative);
    await mkdir(path.dirname(destination), {recursive:true});
    await writeFile(destination, html.replace('</head>', `<meta http-equiv="Content-Security-Policy" content="${escape(csp)}"></head>`));
  }
  for (const file of ['styles.css','app.js','entry.mjs','locale.mjs','404.html']) await cp(path.join(source,file),path.join(outputDirectory,file));
  await cp(path.join(source,'assets'),path.join(outputDirectory,'assets'),{recursive:true});
  await writeFile(path.join(outputDirectory,'content.mjs'),`export const messages = ${JSON.stringify(messages)};\n`);
  const redirects = '/zh /zh/ 301\n/en /en/ 301\n';
  await writeFile(path.join(outputDirectory,'_redirects'),redirects);
  const headers = (await readFile(path.join(source,'_headers'),'utf8')).replace(/Content-Security-Policy:.*$/m,`Content-Security-Policy: ${csp}; frame-ancestors 'none'`) + (isPreview ? '\n/*\n  X-Robots-Tag: noindex, nofollow\n' : '');
  await writeFile(path.join(outputDirectory,'_headers'),headers);
  await writeFile(path.join(outputDirectory,'robots.txt'),isPreview ? 'User-agent: *\nDisallow: /\n' : `User-agent: *\nAllow: /\nSitemap: ${siteUrl}/sitemap.xml\n`);
  const sitemapUrls = alternates.map(([,url])=>`<url><loc>${escape(url)}</loc>${alternates.map(([lang,href])=>`<xhtml:link rel="alternate" hreflang="${lang}" href="${escape(href)}"/>`).join('')}</url>`).join('\n');
  await writeFile(path.join(outputDirectory,'sitemap.xml'),`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${sitemapUrls}\n</urlset>\n`);
  return {siteUrl,preview:isPreview,outputDirectory,pages:generated.map(([name])=>name)};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await buildSite({preview:process.argv.includes('--preview')}),null,2));
}
