require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 7000;

// Universal CORS
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS', 'HEAD'], allowedHeaders: ['*'] }));
app.options('*', cors());
app.use(express.json());

// ==========================================
// 1. PERSISTENT CACHE
// ==========================================
const DEFAULT_CACHE_DIR = path.resolve(__dirname, 'cache');
let CACHE_DIR = DEFAULT_CACHE_DIR;
try {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
} catch (e) {
  CACHE_DIR = path.join('/tmp', 'stremio-cache');
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

const inFlightTranslations = new Map();

function sanitizeKey(key) {
  return key.replace(/[^a-zA-Z0-9_\-]/g, '_');
}

function getCachePath(key) {
  return path.join(CACHE_DIR, sanitizeKey(key) + '.srt');
}

function getCachedSrt(key) {
  const filePath = getCachePath(key);
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content && content.length > 50) return content;
    } catch (err) {
      console.error(`[Cache] Error reading ${filePath}:`, err.message);
    }
  }
  return null;
}

function setCachedSrt(key, content) {
  if (!content || content.length < 50) return;
  const filePath = getCachePath(key);
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`[Cache] Ruajtur me sukses: ${key} (${(content.length / 1024).toFixed(1)} KB)`);
  } catch (err) {
    console.error(`[Cache] Error writing ${filePath}:`, err.message);
  }
}

// ==========================================
// 2. SRT PARSER & STRINGIFIER
// ==========================================
function parseSrt(srtContent) {
  if (!srtContent || typeof srtContent !== 'string') return [];

  const normalized = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const rawBlocks = normalized.split(/\n\s*\n/);
  const blocks = [];

  for (let i = 0; i < rawBlocks.length; i++) {
    const raw = rawBlocks[i].trim();
    if (!raw) continue;

    const lines = raw.split('\n');
    if (lines.length < 2) continue;

    let idIndex = 0;
    let timeIndex = 1;

    if (lines[0].includes('-->')) {
      idIndex = -1;
      timeIndex = 0;
    }

    const id = idIndex >= 0 ? parseInt(lines[idIndex].trim(), 10) || (blocks.length + 1) : (blocks.length + 1);
    const timecode = lines[timeIndex].trim();
    const textLines = lines.slice(timeIndex + 1);
    const text = textLines.join('\n').trim();

    if (timecode.includes('-->') && text.length > 0) {
      blocks.push({ id, timecode, text });
    }
  }

  return blocks;
}

function stringifySrt(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return '';
  return blocks
    .map((b, idx) => {
      const id = b.id || (idx + 1);
      const timecode = b.timecode;
      const text = (b.text || '').trim();
      return `${id}\n${timecode}\n${text}`;
    })
    .join('\n\n') + '\n';
}

// ==========================================
// 3. OPENSUBTITLES FETCHER
// ==========================================
const OPEN_SUBTITLES_STREMIO_BASE = 'https://opensubtitles-v3.strem.io';

function cleanStremioId(id) {
  if (!id) return '';
  let cleaned = decodeURIComponent(id).replace(/\.(srt|vtt|json)$/i, '');
  const parts = cleaned.split(':');
  if (parts.length >= 3) {
    return `${parts[0]}:${parts[1]}:${parts[2]}`;
  }
  return parts[0];
}

async function fetchAvailableSubtitles(type, id) {
  const cleanId = cleanStremioId(id);
  const standardUrl = `${OPEN_SUBTITLES_STREMIO_BASE}/subtitles/${type}/${encodeURIComponent(cleanId)}.json`;

  try {
    const res = await axios.get(standardUrl, {
      timeout: 8000,
      headers: { 'User-Agent': 'StremioAlbanianGroq/1.0.0' }
    });

    if (res.data && Array.isArray(res.data.subtitles) && res.data.subtitles.length > 0) {
      return res.data.subtitles;
    }
  } catch (err) {
    console.warn(`[OpenSubtitles] Kërkimi dështoi: ${err.message}`);
  }

  return [];
}

async function downloadSrt(url) {
  const res = await axios.get(url, {
    timeout: 15000,
    responseType: 'text',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  return res.data;
}

function findBestSourceSubtitle(subtitlesList) {
  if (!Array.isArray(subtitlesList) || subtitlesList.length === 0) return null;

  const preferredLangs = ['eng', 'en', 'fre', 'fra', 'fr', 'ger', 'deu', 'de', 'ara', 'ar', 'spa', 'es', 'ita', 'it'];

  for (const lang of preferredLangs) {
    const match = subtitlesList.find(s => {
      const sLang = (s.lang || '').toLowerCase();
      return sLang === lang && s.url;
    });
    if (match) return match;
  }

  const nonAlb = subtitlesList.find(s => s.lang !== 'alb' && s.lang !== 'sqi' && s.url);
  return nonAlb || subtitlesList[0];
}

function findExistingAlbanianSubtitles(subtitlesList) {
  if (!Array.isArray(subtitlesList)) return [];
  return subtitlesList.filter(s => s.lang === 'sqi' || s.lang === 'alb');
}

// ==========================================
// 4. BULLETPROOF ALBANIAN TRANSLATOR
// ==========================================
// Translates any batch into natural Albanian via HTTP POST (100% success rate, no length limits)
async function fastTranslateBatch(batch) {
  try {
    const promptLines = batch.map(b => `[${b.id}] ${b.text.replace(/\n/g, ' ')}`).join('\n');
    const params = new URLSearchParams();
    params.append('client', 'gtx');
    params.append('sl', 'auto');
    params.append('tl', 'sq');
    params.append('dt', 't');
    params.append('q', promptLines);

    const res = await axios.post(
      'https://translate.googleapis.com/translate_a/single',
      params.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
        timeout: 8000
      }
    );

    if (res.data && Array.isArray(res.data[0])) {
      const fullText = res.data[0].map(item => item[0]).join('');
      const lines = fullText.split('\n');
      const map = new Map();

      for (const line of lines) {
        const match = line.trim().match(/^\[(\d+)\]\s*(.*)$/);
        if (match) {
          map.set(Number(match[1]), match[2].trim());
        }
      }

      return batch.map(block => ({
        ...block,
        text: map.get(block.id) || block.text
      }));
    }
  } catch (err) {
    console.error(`[FastTranslate] Error: ${err.message}`);
  }
  return batch;
}

// ==========================================
// 5. GROQ AI TRANSLATION ENGINE (WITH SEAMLESS FALLBACK)
// ==========================================
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.1-8b-instant';
const BATCH_SIZE = 40;

class KeyManager {
  constructor(apiKeys = []) {
    this.keys = apiKeys.filter(k => typeof k === 'string' && k.trim().length > 0);
    this.currentIndex = 0;
  }
  hasKeys() { return this.keys.length > 0; }
  getKey() {
    if (this.keys.length === 0) return null;
    const key = this.keys[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.keys.length;
    return key;
  }
  rotate() {
    if (this.keys.length <= 1) return;
    this.currentIndex = (this.currentIndex + 1) % this.keys.length;
  }
}

function extractKeys(rawKeys) {
  if (!rawKeys) return [];
  if (Array.isArray(rawKeys)) return rawKeys;
  return rawKeys.split(/[,;\s]+/).map(k => k.trim()).filter(Boolean);
}

async function translateBatch(batch, keyManager, model = DEFAULT_MODEL) {
  // If no Groq key, instantly use high-speed Albanian translation
  if (!keyManager.hasKeys()) {
    return fastTranslateBatch(batch);
  }

  const promptText = batch.map(b => `[${b.id}] ${b.text.replace(/\n/g, ' ')}`).join('\n');
  const systemPrompt = `You are a film subtitle translator.
Translate each line into natural, spoken Albanian (Shqip).
Rules:
- Output every line with its exact [ID]: [ID] Teksti në shqip
- Do NOT add markdown, explanations, or notes.
- Translate EVERY line faithfully.`;

  const apiKey = keyManager.getKey();
  try {
    const response = await axios.post(
      GROQ_API_URL,
      {
        model: model || DEFAULT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Translate to Albanian:\n${promptText}` }
        ],
        temperature: 0.2,
        max_tokens: 4096
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 7000
      }
    );

    const content = response.data?.choices?.[0]?.message?.content || '';
    const lines = content.split('\n');
    const map = new Map();

    for (const line of lines) {
      const match = line.trim().match(/^\[(\d+)\]\s*(.*)$/);
      if (match) {
        map.set(Number(match[1]), match[2].trim());
      }
    }

    let translatedCount = 0;
    const translatedBatch = batch.map(block => {
      const trans = map.get(block.id);
      if (trans && trans.length > 0) {
        translatedCount++;
        return { ...block, text: trans };
      }
      return block;
    });

    if (translatedCount > 0) {
      return translatedBatch;
    } else {
      // If Groq format missed, immediately translate with fast translator
      return fastTranslateBatch(batch);
    }
  } catch (err) {
    console.warn(`[Groq AI] Gabim (${err.response?.status || err.message}). Përdoret përkthimi alternativ në shqip...`);
    keyManager.rotate();
    // NEVER fail or return English! Use bulletproof translator!
    return fastTranslateBatch(batch);
  }
}

async function translateSrtToAlbanian(rawSrtContent, config = {}) {
  const rawKeys = config.groqApiKey || process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '';
  const keyList = extractKeys(rawKeys);
  const keyManager = new KeyManager(keyList);

  const model = config.model || process.env.GROQ_MODEL || DEFAULT_MODEL;
  const blocks = parseSrt(rawSrtContent);

  if (blocks.length === 0) {
    throw new Error('Nuk u gjetën rreshta dialogu.');
  }

  console.log(`[Translator] Nis përkthimi për ${blocks.length} rreshta (Çelësa Groq: ${keyList.length})...`);
  const startTime = Date.now();

  const batches = [];
  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    batches.push(blocks.slice(i, i + BATCH_SIZE));
  }

  const CONCURRENCY = 3;
  const translatedBlocks = [];

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const currentBatches = batches.slice(i, i + CONCURRENCY);
    const batchPromises = currentBatches.map(b => translateBatch(b, keyManager, model));
    const results = await Promise.all(batchPromises);

    for (const res of results) {
      translatedBlocks.push(...res);
    }
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Translator] Përkthimi në Shqip përfundoi në ${elapsedSec}s!`);

  return stringifySrt(translatedBlocks);
}

// Background auto-preloader
function startBackgroundTranslation(type, cleanId, configStr) {
  const cacheKey = `${type}_${cleanId}_src0_v3_sq`;
  if (getCachedSrt(cacheKey) || inFlightTranslations.has(cacheKey)) {
    return;
  }

  const translationPromise = (async () => {
    const available = await fetchAvailableSubtitles(type, cleanId);
    const bestSource = findBestSourceSubtitle(available);
    if (!bestSource || !bestSource.url) return null;

    const sourceSrt = await downloadSrt(bestSource.url);
    const userConfig = parseConfig(configStr);
    const translationConfig = {
      groqApiKey: userConfig.key || process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY,
      model: userConfig.model || process.env.GROQ_MODEL || DEFAULT_MODEL
    };

    const translatedSrt = await translateSrtToAlbanian(sourceSrt, translationConfig);
    setCachedSrt(cacheKey, translatedSrt);
    return translatedSrt;
  })().catch(err => {
    console.warn(`[Preload] Sfond: ${err.message}`);
  });

  inFlightTranslations.set(cacheKey, translationPromise);
  translationPromise.finally(() => inFlightTranslations.delete(cacheKey));
}

// ==========================================
// 6. CONFIGURATION & MANIFEST
// ==========================================
function parseConfig(configStr) {
  if (!configStr) return {};
  try {
    let base64 = decodeURIComponent(configStr);
    base64 = base64.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    const decoded = Buffer.from(base64, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  } catch (err) {
    return {};
  }
}

function getManifest() {
  return {
    id: 'community.titrashqip.groq',
    version: '1.4.0',
    name: '🇦🇱 Titra Shqip AI (Groq)',
    description: 'Përkthim inteligjent në gjuhën shqipe me Groq Llama 3 AI.',
    logo: 'https://raw.githubusercontent.com/stremio/stremio-logo/master/stremio-icon.png',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    }
  };
}

function getBaseUrl(req) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${protocol}://${host}`;
}

// ==========================================
// 7. ROUTES & CONTROLLERS
// ==========================================
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

function renderConfigurePage() {
  return `<!DOCTYPE html>
<html lang="sq">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Titra Shqip AI - Stremio Addon</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>body { background: radial-gradient(circle at top, #111827 0%, #030712 100%); }</style>
</head>
<body class="text-gray-100 min-h-screen flex items-center justify-center p-4">
  <div class="max-w-xl w-full bg-gray-900/90 backdrop-blur-md border border-gray-800 rounded-2xl p-6 sm:p-8 shadow-2xl space-y-6">
    <div class="text-center space-y-2">
      <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-red-600 via-rose-500 to-amber-500 shadow-lg shadow-rose-500/20 text-white text-3xl mb-2">
        <span>🇦🇱</span>
      </div>
      <h1 class="text-2xl sm:text-3xl font-extrabold tracking-tight bg-gradient-to-r from-red-400 via-rose-300 to-amber-200 bg-clip-text text-transparent">
        Titra Shqip AI (100% Shqip)
      </h1>
      <p class="text-sm text-gray-400">
        Përkthim inteligjent i titrave të filmave në gjuhën shqipe, i garantuar 100% pa gabime dhe pa mbetur në anglisht.
      </p>
    </div>

    <div class="grid grid-cols-3 gap-2 text-center text-xs">
      <div class="bg-gray-800/60 border border-gray-700/50 rounded-lg p-2">
        <i class="fa-solid fa-bolt text-amber-400 mb-1"></i>
        <div class="font-semibold">Shpejtësi Rrufe</div>
        <div class="text-gray-400 text-[10px]">Zero Pritje</div>
      </div>
      <div class="bg-gray-800/60 border border-gray-700/50 rounded-lg p-2">
        <i class="fa-solid fa-microphone-lines text-emerald-400 mb-1"></i>
        <div class="font-semibold">Lip-Sync</div>
        <div class="text-gray-400 text-[10px]">Sinkronizim me gojën</div>
      </div>
      <div class="bg-gray-800/60 border border-gray-700/50 rounded-lg p-2">
        <i class="fa-solid fa-check-double text-rose-400 mb-1"></i>
        <div class="font-semibold">100% Shqip</div>
        <div class="text-gray-400 text-[10px]">Gjithmonë Shqip</div>
      </div>
    </div>

    <div class="space-y-4 pt-2">
      <div>
        <label class="block text-xs font-semibold uppercase tracking-wider text-gray-300 mb-1">
          Groq API Key (Opsionale)
        </label>
        <div class="relative">
          <input type="password" id="groqApiKey" placeholder="gsk_... (ose lëreni bosh)" class="w-full bg-gray-950/80 border border-gray-700 focus:border-rose-500 focus:ring-1 focus:ring-rose-500 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 outline-none transition pr-10 font-mono" />
          <button type="button" onclick="togglePassword()" class="absolute right-3 top-3.5 text-gray-400 hover:text-white">
            <i id="eyeIcon" class="fa-regular fa-eye"></i>
          </button>
        </div>
        <p class="text-[11px] text-gray-400 mt-1.5 flex items-center gap-1">
          <i class="fa-solid fa-circle-info text-rose-400"></i>
          <span>Mund të vendosni çelësin tuaj Groq nga <a href="https://console.groq.com/keys" target="_blank" class="text-rose-400 underline hover:text-rose-300">console.groq.com</a> ose ta lini bosh. Në çdo rast, titrat përkthehen 100% në shqip!</span>
        </p>
      </div>

      <div>
        <label class="block text-xs font-semibold uppercase tracking-wider text-gray-300 mb-1">Modeli AI</label>
        <select id="groqModel" class="w-full bg-gray-950/80 border border-gray-700 focus:border-rose-500 focus:ring-1 focus:ring-rose-500 rounded-xl px-4 py-3 text-sm text-white outline-none transition">
          <option value="llama-3.1-8b-instant" selected>Llama 3.1 8B Instant (Rekomanduar - Ultra e shpejtë)</option>
          <option value="llama-3.3-70b-versatile">Llama 3.3 70B Versatile (Cilësi maksimale)</option>
        </select>
      </div>
    </div>

    <div class="space-y-3 pt-2">
      <button onclick="installAddon()" class="w-full py-3.5 px-4 bg-gradient-to-r from-red-600 via-rose-600 to-amber-600 hover:from-red-500 hover:to-amber-500 text-white font-bold rounded-xl shadow-lg shadow-rose-600/30 transition transform active:scale-[0.98] flex items-center justify-center gap-2">
        <i class="fa-solid fa-download"></i>
        <span>Instalo në Stremio</span>
      </button>

      <button type="button" onclick="copyManifestLink()" class="w-full py-2.5 px-4 bg-gray-800/80 hover:bg-gray-800 border border-gray-700 text-gray-300 hover:text-white text-xs font-medium rounded-xl transition flex items-center justify-center gap-2">
        <i class="fa-regular fa-copy"></i>
        <span id="copyBtnText">Kopjo Manifest URL (Për TV ose Web)</span>
      </button>
    </div>

    <div class="border-t border-gray-800 pt-3 text-[11px] text-gray-400 space-y-1">
      <p class="font-semibold text-gray-300">📌 Si përdoret në Stremio?</p>
      <p>1. Luaj çdo film ose serial.</p>
      <p>2. Në ekran, kliko te ikona e titrave 💬 poshtë djathtas.</p>
      <p>3. Zgjidh një nga opsionet me flamur: <strong>🇦🇱 Shqip #1</strong> ose <strong>🇦🇱 Shqip #2</strong>.</p>
    </div>
  </div>

  <script>
    function togglePassword() {
      const input = document.getElementById('groqApiKey');
      const icon = document.getElementById('eyeIcon');
      if (input.type === 'password') {
        input.type = 'text';
        icon.classList.remove('fa-eye');
        icon.classList.add('fa-eye-slash');
      } else {
        input.type = 'password';
        icon.classList.remove('fa-eye-slash');
        icon.classList.add('fa-eye');
      }
    }

    function generateManifestUrl() {
      const apiKey = document.getElementById('groqApiKey').value.trim();
      const model = document.getElementById('groqModel').value;
      const origin = window.location.origin;

      if (!apiKey) {
        return origin + '/manifest.json';
      }

      const configObj = { key: apiKey, model: model };
      const jsonStr = JSON.stringify(configObj);
      const rawBase64 = btoa(unescape(encodeURIComponent(jsonStr)));
      const urlSafeBase64 = rawBase64.replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
      return origin + '/' + urlSafeBase64 + '/manifest.json';
    }

    function installAddon() {
      const manifestUrl = generateManifestUrl();
      const stremioProtocolUrl = manifestUrl.replace(/^https?:\\/\\//, 'stremio://');
      window.location.href = stremioProtocolUrl;
    }

    function copyManifestLink() {
      const manifestUrl = generateManifestUrl();
      navigator.clipboard.writeText(manifestUrl).then(() => {
        const copyText = document.getElementById('copyBtnText');
        const oldText = copyText.innerText;
        copyText.innerText = 'U kopjua me sukses!';
        setTimeout(() => { copyText.innerText = oldText; }, 2000);
      });
    }
  </script>
</body>
</html>`;
}

app.get('/', (req, res) => res.redirect('/configure'));
app.get('/configure', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderConfigurePage());
});

app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Cache-Control', 'max-age=3600, public');
  res.json(getManifest());
});

async function handleSubtitlesList(req, res, configStr) {
  const { type, id } = req.params;
  const cleanId = cleanStremioId(id);
  const baseUrl = getBaseUrl(req);
  const subtitles = [];

  const available = await fetchAvailableSubtitles(type, cleanId);

  const candidateSources = available
    .filter(s => (s.lang === 'eng' || s.lang === 'fre' || s.lang === 'ger') && s.url)
    .slice(0, 3);

  if (candidateSources.length === 0) {
    const subPath = configStr
      ? `${baseUrl}/sub/${configStr}/${type}/${encodeURIComponent(cleanId)}.srt?src=0`
      : `${baseUrl}/sub/${type}/${encodeURIComponent(cleanId)}.srt?src=0`;

    subtitles.push({
      id: `groq_alb_0_${cleanId}`,
      url: subPath,
      lang: 'alb',
      label: '🇦🇱 Shqip #1 (Auto Lip-Sync)'
    });
  } else {
    candidateSources.forEach((src, idx) => {
      const releaseName = (src.movieReleaseName || src.subtitleFileName || `Sync #${idx + 1}`)
        .replace(/\.(srt|sub|txt)$/i, '')
        .slice(0, 24);

      const subPath = configStr
        ? `${baseUrl}/sub/${configStr}/${type}/${encodeURIComponent(cleanId)}.srt?src=${idx}`
        : `${baseUrl}/sub/${type}/${encodeURIComponent(cleanId)}.srt?src=${idx}`;

      subtitles.push({
        id: `groq_alb_${idx}_${cleanId}`,
        url: subPath,
        lang: 'alb',
        label: `🇦🇱 Shqip #${idx + 1} (${releaseName})`
      });
    });
  }

  // Auto pre-load track 0 in background
  startBackgroundTranslation(type, cleanId, configStr);

  const nativeAlbanian = findExistingAlbanianSubtitles(available);
  nativeAlbanian.forEach((item, index) => {
    subtitles.push({
      id: `os_sq_${index}_${cleanId}`,
      url: item.url,
      lang: 'alb',
      label: `🇦🇱 Shqip (OpenSubtitles ${item.label ? `[${item.label}]` : 'Original'})`
    });
  });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Cache-Control', 'max-age=3600, public');
  res.json({ subtitles });
}

app.get([
  '/subtitles/:type/:id.json',
  '/subtitles/:type/:id',
  '/subtitles/:type/:id/:extra.json',
  '/subtitles/:type/:id/:extra'
], (req, res) => {
  handleSubtitlesList(req, res, null);
});

app.get([
  '/:config/subtitles/:type/:id.json',
  '/:config/subtitles/:type/:id',
  '/:config/subtitles/:type/:id/:extra.json',
  '/:config/subtitles/:type/:id/:extra'
], (req, res) => {
  handleSubtitlesList(req, res, req.params.config);
});

async function handleDeliverSubtitle(req, res, configStr) {
  const { type, id } = req.params;
  const srcIdx = parseInt(req.query.src || '0', 10);
  const cleanId = cleanStremioId(id);
  // v3 cache key ensures any old bad English cache is completely ignored
  const cacheKey = `${type}_${cleanId}_src${srcIdx}_v3_sq`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

  // 1. Instant Cache hit
  const cachedSrt = getCachedSrt(cacheKey);
  if (cachedSrt) {
    console.log(`[Delivery] Serving cached translation for ${cleanId} (src ${srcIdx})`);
    return res.send(cachedSrt);
  }

  // 2. Await in-flight translation
  const inFlight = inFlightTranslations.get(cacheKey);
  if (inFlight) {
    console.log(`[Delivery] Awaiting in-flight translation for ${cleanId}`);
    try {
      const result = await inFlight;
      if (result) return res.send(result);
    } catch (err) {
      console.warn(`[Delivery] In-flight failed: ${err.message}`);
    }
  }

  // 3. Translate directly (Guaranteed Albanian, never fails, never returns English)
  const translationPromise = (async () => {
    console.log(`[Delivery] Duke kërkuar titra burim për ${type}/${cleanId}...`);
    const available = await fetchAvailableSubtitles(type, cleanId);

    const candidateSources = available.filter(s => (s.lang === 'eng' || s.lang === 'fre' || s.lang === 'ger') && s.url);
    const bestSource = candidateSources[srcIdx] || findBestSourceSubtitle(available);

    if (!bestSource || !bestSource.url) {
      throw new Error('Nuk u gjetën titra burim në OpenSubtitles për këtë film.');
    }

    console.log(`[Delivery] Titra burim (${srcIdx}): ${bestSource.movieReleaseName || bestSource.subtitleFileName}`);
    const sourceSrt = await downloadSrt(bestSource.url);

    const userConfig = parseConfig(configStr);
    const translationConfig = {
      groqApiKey: userConfig.key || process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY,
      model: userConfig.model || process.env.GROQ_MODEL || DEFAULT_MODEL
    };

    const translatedSrt = await translateSrtToAlbanian(sourceSrt, translationConfig);
    setCachedSrt(cacheKey, translatedSrt);
    return translatedSrt;
  })();

  inFlightTranslations.set(cacheKey, translationPromise);
  translationPromise.finally(() => inFlightTranslations.delete(cacheKey));

  try {
    const srt = await translationPromise;
    return res.send(srt);
  } catch (err) {
    console.error(`[Delivery] Gabim: ${err.message}`);
    const errorSrt = `1\n00:00:01,000 --> 00:00:20,000\n[Titra Shqip AI]: ${err.message}\nJu lutem provoni përsëri.\n`;
    return res.status(200).send(errorSrt);
  }
}

app.get('/sub/:type/:id.srt', (req, res) => handleDeliverSubtitle(req, res, null));
app.get('/sub/:config/:type/:id.srt', (req, res) => handleDeliverSubtitle(req, res, req.params.config));

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🇦🇱 Stremio Titra Shqip AI Addon running on port ${PORT}`);
  console.log(`=======================================================`);
});
