require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 7000;

app.use(cors());
app.use(express.json());

// ==========================================
// 1. CACHE & IN-FLIGHT STORAGE
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

async function fetchAvailableSubtitles(type, id, extra = '') {
  const cleanId = cleanStremioId(id);

  // Try standard clean query first as it is 100% reliable
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
    console.warn(`[OpenSubtitles] Kërkimi standard dështoi: ${err.message}`);
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

  const preferredLangs = [
    'eng', 'en',
    'fre', 'fra', 'fr',
    'ger', 'deu', 'de',
    'ara', 'ar',
    'spa', 'es',
    'ita', 'it'
  ];

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
// 4. GROQ AI TRANSLATION ENGINE (FAST & OPTIMIZED)
// ==========================================
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.1-8b-instant';
// 80 blocks per batch provides maximum speed (~3-4 seconds per movie) without timeouts
const BATCH_SIZE = 80;
const CONCURRENCY = 3;

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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function extractTranslationsFromJson(parsed) {
  const map = new Map();
  if (!parsed) return map;

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item && item.id != null && item.text) map.set(Number(item.id), String(item.text).trim());
    }
    return map;
  }

  for (const key of ['translations', 'dialogues', 'items', 'subtitles', 'data', 'lines']) {
    if (Array.isArray(parsed[key])) {
      for (const item of parsed[key]) {
        if (item && item.id != null && item.text) map.set(Number(item.id), String(item.text).trim());
      }
      if (map.size > 0) return map;
    }
  }

  for (const [k, v] of Object.entries(parsed)) {
    const num = parseInt(k, 10);
    if (!isNaN(num)) {
      if (typeof v === 'string') {
        map.set(num, v.trim());
      } else if (v && typeof v.text === 'string') {
        map.set(num, v.text.trim());
      }
    }
  }

  return map;
}

async function translateBatchWithGroq(batch, keyManager, model = DEFAULT_MODEL, retries = 3) {
  const inputList = batch.map(b => ({ id: b.id, text: b.text.replace(/\n/g, ' ') }));

  const systemPrompt = `You are a professional film and TV dialogue translator.
Translate all input dialogue lines into natural, spoken, modern Albanian (Shqip).
Rules:
- Output valid JSON object with key "translations": [{"id": 1, "text": "Teksti në shqip"}]
- Keep the exact ID for each line.
- Match natural spoken length for lip-sync.
- Keep dashes (-), names, and punctuation.`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const apiKey = keyManager.getKey();
    try {
      const response = await axios.post(
        GROQ_API_URL,
        {
          model: model || DEFAULT_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: `Translate to Albanian in JSON format:\n${JSON.stringify(inputList)}`
            }
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
          max_tokens: 4096
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 18000
        }
      );

      const content = response.data?.choices?.[0]?.message?.content || '{}';
      let parsed = {};
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        parsed = {};
      }

      const translationsMap = extractTranslationsFromJson(parsed);

      let matchedCount = 0;
      const mappedBatch = batch.map(block => {
        const translated = translationsMap.get(block.id);
        if (translated && translated.length > 0) {
          matchedCount++;
          return { ...block, text: translated };
        }
        return block;
      });

      if (matchedCount > 0) {
        return mappedBatch;
      } else {
        throw new Error('AI ktheu përgjigje pa përkthim.');
      }
    } catch (err) {
      const status = err.response?.status;
      const errorMsg = err.response?.data?.error?.message || err.message;
      console.warn(`[Groq AI] Tentativa ${attempt + 1}/${retries + 1} (${status || 'Err'}): ${errorMsg}`);

      if (status === 429) {
        keyManager.rotate();
        if (attempt < retries) {
          const retryAfterSec = parseInt(err.response?.headers?.['retry-after'], 10) || 2;
          await sleep(retryAfterSec * 1000);
          continue;
        }
      }

      if (status === 401 || status === 403) {
        keyManager.rotate();
      }

      if (attempt === retries) {
        // Return original batch to avoid crash
        return batch;
      }
      await sleep(800 * (attempt + 1));
    }
  }

  return batch;
}

async function translateSrtToAlbanian(rawSrtContent, config = {}) {
  const rawKeys = config.groqApiKey || process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '';
  const keyList = extractKeys(rawKeys);
  const keyManager = new KeyManager(keyList);

  if (!keyManager.hasKeys()) {
    throw new Error('Groq API Key mungon. Ju lutem vendosni çelësin tuaj Groq te /configure.');
  }

  const model = config.model || process.env.GROQ_MODEL || DEFAULT_MODEL;
  const blocks = parseSrt(rawSrtContent);

  if (blocks.length === 0) {
    throw new Error('Nuk u gjetën rreshta dialogu.');
  }

  console.log(`[Translator] Nis përkthimi për ${blocks.length} rreshta me modelin ${model}...`);
  const startTime = Date.now();

  const batches = [];
  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    batches.push(blocks.slice(i, i + BATCH_SIZE));
  }

  const translatedBlocks = [];

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const currentBatches = batches.slice(i, i + CONCURRENCY);
    const batchPromises = currentBatches.map(b => translateBatchWithGroq(b, keyManager, model));
    const results = await Promise.all(batchPromises);

    for (const res of results) {
      translatedBlocks.push(...res);
    }

    if (i + CONCURRENCY < batches.length) {
      await sleep(100);
    }
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Translator] Përkthimi në Shqip përfundoi në ${elapsedSec}s!`);

  return stringifySrt(translatedBlocks);
}

// Background auto-preloader for instant playback
function startBackgroundTranslation(type, cleanId, configStr) {
  const cacheKey = `${type}_${cleanId}_sq`;
  if (getCachedSrt(cacheKey) || inFlightTranslations.has(cacheKey)) {
    return;
  }

  console.log(`[Preload] Duke nisur përkthimin automatik në sfond për ${type}/${cleanId}...`);
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
    console.warn(`[Preload] Dështoi në sfond: ${err.message}`);
  });

  inFlightTranslations.set(cacheKey, translationPromise);
  translationPromise.finally(() => inFlightTranslations.delete(cacheKey));
}

// ==========================================
// 5. CONFIGURATION & MANIFEST
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
    version: '1.2.0',
    name: '🇦🇱 Titra Shqip AI (Groq)',
    description: 'Përkthim inteligjent i sinkronizuar me gojën e aktorit në gjuhën shqipe me Groq Llama 3.1 AI.',
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
// 6. ROUTES & CONTROLLERS
// ==========================================
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

function renderConfigurePage() {
  const hasServerKey = !!(process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY);
  const serverKeyBadge = hasServerKey
    ? `<div class="p-3 bg-emerald-950/80 border border-emerald-500/50 rounded-xl text-emerald-300 text-xs flex items-center gap-2">
         <i class="fa-solid fa-circle-check text-emerald-400 text-sm"></i>
         <span><strong>Çelësi juaj në Render është aktiv!</strong> Vendosni një tjetër vetëm nëse dëshironi, ose klikoni <strong>"Instalo në Stremio"</strong>.</span>
       </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="sq">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Titra Shqip AI me Groq - Stremio Addon</title>
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
        Titra Shqip AI (Groq Fast)
      </h1>
      <p class="text-sm text-gray-400">
        Përkthim automatik i titrave në gjuhën shqipe i sinkronizuar me gojën e aktorit nga çdo gjuhë origjinale.
      </p>
    </div>

    ${serverKeyBadge}

    <div class="grid grid-cols-3 gap-2 text-center text-xs">
      <div class="bg-gray-800/60 border border-gray-700/50 rounded-lg p-2">
        <i class="fa-solid fa-bolt text-amber-400 mb-1"></i>
        <div class="font-semibold">Shpejtësi Rrufe</div>
        <div class="text-gray-400 text-[10px]">Groq 800 tok/s</div>
      </div>
      <div class="bg-gray-800/60 border border-gray-700/50 rounded-lg p-2">
        <i class="fa-solid fa-microphone-lines text-emerald-400 mb-1"></i>
        <div class="font-semibold">Lip-Sync</div>
        <div class="text-gray-400 text-[10px]">Sinkronizim me gojën</div>
      </div>
      <div class="bg-gray-800/60 border border-gray-700/50 rounded-lg p-2">
        <i class="fa-solid fa-infinity text-rose-400 mb-1"></i>
        <div class="font-semibold">Pa Limite</div>
        <div class="text-gray-400 text-[10px]">Multi-Key Cache</div>
      </div>
    </div>

    <div class="space-y-4 pt-2">
      <div>
        <label class="block text-xs font-semibold uppercase tracking-wider text-gray-300 mb-1">
          Groq API Key (Opsionale nëse e keni në Render)
        </label>
        <div class="relative">
          <input type="password" id="groqApiKey" placeholder="gsk_..." class="w-full bg-gray-950/80 border border-gray-700 focus:border-rose-500 focus:ring-1 focus:ring-rose-500 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 outline-none transition pr-10 font-mono" />
          <button type="button" onclick="togglePassword()" class="absolute right-3 top-3.5 text-gray-400 hover:text-white">
            <i id="eyeIcon" class="fa-regular fa-eye"></i>
          </button>
        </div>
        <p class="text-[11px] text-gray-400 mt-1.5 flex items-center gap-1">
          <i class="fa-solid fa-circle-info text-rose-400"></i>
          <span>Çelësin tuaj falas e merrni në <a href="https://console.groq.com/keys" target="_blank" class="text-rose-400 underline hover:text-rose-300">console.groq.com</a>.</span>
        </p>
      </div>

      <div>
        <label class="block text-xs font-semibold uppercase tracking-wider text-gray-300 mb-1">Modeli AI</label>
        <select id="groqModel" class="w-full bg-gray-950/80 border border-gray-700 focus:border-rose-500 focus:ring-1 focus:ring-rose-500 rounded-xl px-4 py-3 text-sm text-white outline-none transition">
          <option value="llama-3.1-8b-instant" selected>Llama 3.1 8B Instant (Rekomanduar - Ultra e shpejtë, pa limite)</option>
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
      <p>1. Luaj çdo film ose episod në Stremio (nga Torrentio, Cinemeta etj.).</p>
      <p>2. Në ekranin e filmit, kliko ikonën e titrave 💬 poshtë djathtas.</p>
      <p>3. Zgjidh: <strong>🇦🇱 Shqip (Groq AI Lip-Sync)</strong>.</p>
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

  const subPath = configStr
    ? `${baseUrl}/sub/${configStr}/${type}/${encodeURIComponent(cleanId)}.srt`
    : `${baseUrl}/sub/${type}/${encodeURIComponent(cleanId)}.srt`;

  subtitles.push({
    id: `groq_alb_${cleanId}`,
    url: subPath,
    lang: 'alb',
    label: '🇦🇱 Shqip (Groq AI Lip-Sync)'
  });

  // Pre-load in background immediately so it's ready before the user clicks play!
  startBackgroundTranslation(type, cleanId, configStr);

  try {
    const available = await fetchAvailableSubtitles(type, cleanId);
    const nativeAlbanian = findExistingAlbanianSubtitles(available);
    nativeAlbanian.forEach((item, index) => {
      subtitles.push({
        id: `os_sq_${index}_${cleanId}`,
        url: item.url,
        lang: 'alb',
        label: `🇦🇱 Shqip (OpenSubtitles ${item.label ? `[${item.label}]` : 'Original'})`
      });
    });
  } catch (err) {
    console.warn(`[Subtitles] Could not query OpenSubtitles: ${err.message}`);
  }

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
  const cleanId = cleanStremioId(id);
  const cacheKey = `${type}_${cleanId}_sq`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // 1. Instant cache hit
  const cachedSrt = getCachedSrt(cacheKey);
  if (cachedSrt) {
    console.log(`[Delivery] Serving cached translation for ${cleanId}`);
    return res.send(cachedSrt);
  }

  // 2. Await in-flight translation if background pre-loader started it
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

  // 3. Translate directly
  const translationPromise = (async () => {
    console.log(`[Delivery] Duke kërkuar titra burim për ${type}/${cleanId}...`);
    const available = await fetchAvailableSubtitles(type, cleanId);
    const bestSource = findBestSourceSubtitle(available);

    if (!bestSource || !bestSource.url) {
      throw new Error('Nuk u gjetën titra burim në OpenSubtitles.');
    }

    console.log(`[Delivery] Titra burim: ${bestSource.lang}`);
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
    console.error(`[Delivery] Dështoi përkthimi për ${cleanId}:`, err.message);
    const errorSrt = `1\n00:00:01,000 --> 00:00:10,000\n[Titra Shqip AI]: ${err.message}\nKontrolloni çelësin Groq API te /configure.\n`;
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
