require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const path = require('path');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// === fetch with timeout (AbortController - node-fetch v2 compatible) ===
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// === Analysis Functions ===
function analyzeSchema($, html) {
  const checks = [
    { name: 'JSON-LD Schema', passed: $('script[type="application/ld+json"]').length > 0 },
    { name: 'LocalBusiness / Organization', passed: html.includes('"LocalBusiness"') || html.includes('"Organization"') },
    { name: 'FAQPage Schema', passed: html.includes('"FAQPage"') },
    { name: 'Review / AggregateRating', passed: html.includes('"AggregateRating"') || html.includes('"Review"') },
    { name: 'BreadcrumbList', passed: html.includes('"BreadcrumbList"') }
  ];
  const passed = checks.filter(c => c.passed).length;
  return { score: Math.round((passed / checks.length) * 100), checks };
}

function analyzeContent($, html) {
  const text = $('body').text();
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
  const checks = [
    { name: `حجم المحتوى (${wordCount} كلمة > 500)`, passed: wordCount > 500 },
    { name: 'فقرات منظمة (>= 3)', passed: $('p').length >= 3 },
    { name: 'عناوين فرعية H2/H3', passed: $('h2, h3').length >= 2 },
    { name: 'FAQ أو قوائم', passed: $('ul, ol').length >= 1 },
    { name: 'أرقام وإحصائيات', passed: /\d+%|\d+\.?\d+/.test(text) }
  ];
  const passed = checks.filter(c => c.passed).length;
  return { score: Math.round((passed / checks.length) * 100), checks, wordCount };
}

function analyzeEEAT($, html) {
  const checks = [
    { name: 'صفحة "من نحن"', passed: $('a[href*="about"]').length > 0 || html.toLowerCase().includes('من نحن') || html.toLowerCase().includes('about us') },
    { name: 'صفحة "اتصل بنا"', passed: $('a[href*="contact"]').length > 0 || html.toLowerCase().includes('اتصل') || html.toLowerCase().includes('contact') },
    { name: 'معلومات الكاتب', passed: html.toLowerCase().includes('author') || $('[rel="author"]').length > 0 },
    { name: 'روابط التواصل الاجتماعي', passed: $('a[href*="facebook"], a[href*="twitter"], a[href*="linkedin"], a[href*="instagram"]').length > 0 },
    { name: 'سياسة الخصوصية', passed: $('a[href*="privacy"]').length > 0 || html.toLowerCase().includes('privacy') || html.toLowerCase().includes('خصوصية') }
  ];
  const passed = checks.filter(c => c.passed).length;
  return { score: Math.round((passed / checks.length) * 100), checks };
}

function analyzeTechnical($, html) {
  const checks = [
    { name: 'Meta Description', passed: $('meta[name="description"]').attr('content')?.length > 0 },
    { name: 'Open Graph Tags', passed: $('meta[property="og:title"]').length > 0 },
    { name: 'Canonical URL', passed: $('link[rel="canonical"]').length > 0 },
    { name: 'lang attribute', passed: !!$('html').attr('lang') },
    { name: 'Viewport Meta', passed: $('meta[name="viewport"]').length > 0 }
  ];
  const passed = checks.filter(c => c.passed).length;
  return { score: Math.round((passed / checks.length) * 100), checks };
}

// === API: /api/fetch (used by frontend) ===
app.post('/api/fetch', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: 'الرابط مطلوب' });
  if (!url.startsWith('http')) url = 'https://' + url;

  try {
    const response = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GEO-Analyzer/1.0)' }
    }, 10000);

    if (!response.ok) throw new Error(`فشل جلب الصفحة: ${response.status}`);

    const html = await response.text();
    const sizeKB = Math.round(Buffer.byteLength(html, 'utf8') / 1024);
    const finalUrl = response.url || url;

    res.json({ html, finalUrl, sizeKB });
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'انتهت مهلة الاتصال (10 ثوانٍ)' : err.message;
    res.status(500).json({ error: msg });
  }
});

// === API: /api/analyze (server-side full analysis) ===
app.post('/api/analyze', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'يرجى إدخال رابط الموقع' });
  if (!url.startsWith('http')) url = 'https://' + url;

  try {
    const response = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GEO-Analyzer/1.0)' }
    }, 10000);

    if (!response.ok) throw new Error(`فشل جلب الصفحة: ${response.status}`);

    const html = await response.text();
    const $ = cheerio.load(html);

    const schema = analyzeSchema($, html);
    const content = analyzeContent($, html);
    const eeat = analyzeEEAT($, html);
    const technical = analyzeTechnical($, html);

    const total = Math.round(
      schema.score * 0.30 +
      content.score * 0.30 +
      eeat.score * 0.25 +
      technical.score * 0.15
    );

    res.json({ success: true, url, scores: { schema, content, eeat, technical, total }, timestamp: new Date().toISOString() });
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'انتهت مهلة الاتصال' : err.message;
    res.status(500).json({ success: false, error: msg });
  }
});

// === API: /api/export-pdf ===
app.post('/api/export-pdf', async (req, res) => {
  const { url, scores } = req.body;
  if (!url || !scores) return res.status(400).json({ success: false, error: 'بيانات غير مكتملة' });

  const doc = new PDFDocument({ margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=geo-report-${Date.now()}.pdf`);
  doc.pipe(res);

  doc.fontSize(24).text('GEO Analyzer Report', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text(`URL: ${url}`, { align: 'center' });
  doc.text(`Date: ${new Date().toLocaleDateString('ar-EG')}`, { align: 'center' });
  doc.moveDown(2);
  doc.fontSize(18).text(`Total Score: ${scores.total}/100`, { align: 'center' });
  doc.moveDown(2);
  doc.fontSize(14).text('Category Breakdown:', { underline: true });
  doc.moveDown();
  doc.fontSize(12);
  doc.text(`- Schema Markup: ${scores.schema?.score ?? 'N/A'}%`);
  doc.text(`- Content Quality: ${scores.content?.score ?? 'N/A'}%`);
  doc.text(`- E-E-A-T: ${scores.eeat?.score ?? 'N/A'}%`);
  doc.text(`- Technical SEO: ${scores.technical?.score ?? 'N/A'}%`);
  doc.moveDown(2);
  doc.fontSize(14).text('Recommendations:', { underline: true });
  doc.moveDown();

  const recs = [];
  if ((scores.schema?.score ?? 100) < 80) recs.push('- Add Schema Markup (JSON-LD)');
  if ((scores.content?.score ?? 100) < 80) recs.push('- Increase content to 500+ words');
  if ((scores.eeat?.score ?? 100) < 80) recs.push('- Add About Us and Contact pages');
  if ((scores.technical?.score ?? 100) < 80) recs.push('- Add meta description and OG tags');

  doc.fontSize(12).text(recs.length === 0 ? 'No recommendations - Your site is excellent!' : recs.join('\n'));
  doc.end();
});

// الصفحة الرئيسية
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// تشغيل السيرفر
app.listen(PORT, () => {
  console.log(`GEO Analyzer running on http://localhost:${PORT}`);
});
