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

// === دالة جلب وتحليل الصفحة ===
async function analyzePage(url) {
  try {
    // التحقق من صحة الرابط
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    // جلب محتوى الصفحة
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GEO Analyzer/1.0)'
      },
      timeout: 10000
    });

    if (!response.ok) {
      throw new Error(`فشل جلب الصفحة: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // === 1. تحليل Schema Markup (30%) ===
    const schemaScore = analyzeSchema($, html);

    // === 2. تحليل جودة المحتوى (30%) ===
    const contentScore = analyzeContent($, html);

    // === 3. تحليل E-E-A-T (25%) ===
    const eeatScore = analyzeEEAT($, html, url);

    // === 4. التحليل التقني (15%) ===
    const technicalScore = analyzeTechnical($, html, url);

    // حساب الدرجة النهائية
    const totalScore = Math.round(
      (schemaScore.score * 0.30) +
      (contentScore.score * 0.30) +
      (eeatScore.score * 0.25) +
      (technicalScore.score * 0.15)
    );

    return {
      success: true,
      url: url,
      scores: {
        schema: schemaScore,
        content: contentScore,
        eeat: eeatScore,
        technical: technicalScore,
        total: totalScore
      },
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// === دوال التحليل ===

function analyzeSchema($, html) {
  let score = 0;
  const checks = [
    { name: 'JSON-LD موجود', test: () => $('script[type="application/ld+json"]').length > 0 },
    { name: 'LocalBusiness', test: () => html.includes('"@type":"LocalBusiness"') || html.includes('"@type": "LocalBusiness"') },
    { name: 'FAQPage', test: () => html.includes('"@type":"FAQPage"') || html.includes('"@type": "FAQPage"') },
    { name: 'Organization', test: () => html.includes('"@type":"Organization"') || html.includes('"@type": "Organization"') },
    { name: 'Review/Rating', test: () => html.includes('"@type":"Review"') || html.includes('"@type":"AggregateRating"') }
  ];

  const passed = checks.filter(c => c.test()).length;
  score = Math.round((passed / checks.length) * 100);
  
  return { score, details: checks.map(c => ({ name: c.name, passed: c.test() })) };
}

function analyzeContent($, html) {
  let score = 0;
  const text = $('body').text();
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
  
  const checks = [
    { name: 'حجم المحتوى (>500 كلمة)', test: () => wordCount > 500 },
    { name: 'وجود فقرات منظمة', test: () => $('p').length >= 3 },
    { name: 'وجود عناوين فرعية', test: () => $('h2, h3').length >= 2 },
    { name: 'وجود قائمة (FAQ style)', test: () => $('ul, ol').length >= 1 },
    { name: 'وجود أرقام وإحصائيات', test: () => /\d+%|\d+\.?\d*/.test(text) }
  ];

  const passed = checks.filter(c => c.test()).length;
  score = Math.round((passed / checks.length) * 100);

  return { score, details: checks.map(c => ({ name: c.name, passed: c.test() })), wordCount };
}

function analyzeEEAT($, html, url) {
  let score = 0;
  const checks = [
    { name: 'صفحة "من نحن"', test: () => $('a[href*="about"], a:contains("من نحن"), a:contains("About")').length > 0 },
    { name: 'صفحة "اتصل بنا"', test: () => $('a[href*="contact"], a:contains("اتصل"), a:contains("Contact")').length > 0 },
    { name: 'معلومات الكاتب', test: () => html.includes('author') || $('[rel="author"]').length > 0 },
    { name: 'روابط التواصل الاجتماعي', test: () => $('a[href*="facebook"], a[href*="twitter"], a[href*="linkedin"], a[href*="instagram"]').length > 0 },
    { name: 'سياسة الخصوصية', test: () => $('a[href*="privacy"], a:contains("خصوصية"), a:contains("Privacy")').length > 0 }
  ];

  const passed = checks.filter(c => c.test()).length;
  score = Math.round((passed / checks.length) * 100);

  return { score, details: checks.map(c => ({ name: c.name, passed: c.test() })) };
}

function analyzeTechnical($, html, url) {
  let score = 0;
  const checks = [
    { name: 'meta description', test: () => $('meta[name="description"]').length > 0 },
    { name: 'Open Graph tags', test: () => $('meta[property="og:title"], meta[property="og:description"]').length > 0 },
    { name: 'canonical URL', test: () => $('link[rel="canonical"]').length > 0 },
    { name: 'lang attribute', test: () => $('html[lang]').length > 0 },
    { name: 'viewport meta', test: () => $('meta[name="viewport"]').length > 0 }
  ];

  const passed = checks.filter(c => c.test()).length;
  score = Math.round((passed / checks.length) * 100);

  return { score, details: checks.map(c => ({ name: c.name, passed: c.test() })) };
}

// === API Routes ===

// تحليل الموقع
app.post('/api/analyze', async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ success: false, error: 'يرجى إدخال رابط الموقع' });
  }

  const result = await analyzePage(url);
  res.json(result);
});

// تصدير PDF
app.post('/api/export-pdf', async (req, res) => {
  const { url, scores } = req.body;
  
  if (!url || !scores) {
    return res.status(400).json({ success: false, error: 'بيانات غير مكتملة' });
  }

  const doc = new PDFDocument({ margin: 50 });
  
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=geo-report-${Date.now()}.pdf`);
  
  doc.pipe(res);

  // Header
  doc.fontSize(24).text('GEO Analyzer Report', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text(`URL: ${url}`, { align: 'center' });
  doc.text(`Date: ${new Date().toLocaleDateString('ar-EG')}`, { align: 'center' });
  doc.moveDown(2);

  // Total Score
  doc.fontSize(18).text(`Total Score: ${scores.total}/100`, { align: 'center' });
  doc.moveDown(2);

  // Category Scores
  doc.fontSize(14).text('Category Breakdown:', { underline: true });
  doc.moveDown();
  doc.fontSize(12).text(`• Schema Markup: ${scores.schema.score}%`);
  doc.text(`• Content Quality: ${scores.content.score}%`);
  doc.text(`• E-E-A-T: ${scores.eeat.score}%`);
  doc.text(`• Technical: ${scores.technical.score}%`);
  doc.moveDown(2);

  // Recommendations
  doc.fontSize(14).text('Recommendations:', { underline: true });
  doc.moveDown();
  
  const recommendations = [];
  if (scores.schema.score < 80) recommendations.push('• Add Schema Markup (JSON-LD)');
  if (scores.content.score < 80) recommendations.push('• Increase content to 500+ words');
  if (scores.eeat.score < 80) recommendations.push('• Add About Us and Contact pages');
  if (scores.technical.score < 80) recommendations.push('• Add meta description and OG tags');
  
  if (recommendations.length === 0) {
    doc.text('✅ No recommendations - Your site is excellent!');
  } else {
    recommendations.forEach(rec => doc.text(rec));
  }

  doc.end();
});

// الصفحة الرئيسية
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// تشغيل السيرفر
app.listen(PORT, () => {
  console.log(`🚀 GEO Analyzer يعمل على http://localhost:${PORT}`);
});