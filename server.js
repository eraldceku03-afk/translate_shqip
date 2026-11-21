require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const cache = require('./services/cache');
const {
  cleanStremioId,
  fetchAvailableSubtitles,
  downloadSrt,
  findBestEnglishSubtitle,
  findExistingAlbanianSubtitles
} = require('./services/opensubtitles');
const { translateSrtToAlbanian, DEFAULT_MODEL } = require('./services/translator');

const app = express();
const PORT = process.env.PORT || 7000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper to decode Base64 / URL-safe Base64 user configuration
function parseConfig(configStr) {
  if (!configStr) return {};
  try {
    let base64 = decodeURIComponent(configStr);
    // Convert URL-safe base64 back to standard base64
    base64 = base64.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
      base64 += '=';
    }
    const decoded = Buffer.from(base64, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  } catch (err) {
    return {};
  }
}

// Stremio Addon Manifest builder
function getManifest() {
  return {
    id: 'community.titrashqip.groq',
    version: '1.0.0',
    name: '🇦🇱 Titra Shqip AI (Groq)',
    description: 'Përkthim inteligjent i titrave në shqip me Groq AI (Llama 3.1) pa kufizime.',
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

// Base URL helper
function getBaseUrl(req) {
  // Respect Render's X-Forwarded-Proto header
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${protocol}://${host}`;
}

// Landing & Configuration
app.get('/', (req, res) => {
  res.redirect('/configure');
});

app.get('/configure', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// Manifest endpoints
app.get('/manifest.json', (req, res) => {
  res.json(getManifest());
});

app.get('/:config/manifest.json', (req, res) => {
  res.json(getManifest());
});

// Subtitle list handler
async function handleSubtitlesList(req, res, configStr) {
  const { type, id } = req.params;
  const cleanId = cleanStremioId(id);
  const baseUrl = getBaseUrl(req);

  const subtitles = [];

  // 1. AI Groq Translation option (Always provided)
  const subPath = configStr
    ? `${baseUrl}/sub/${configStr}/${type}/${encodeURIComponent(cleanId)}.srt`
    : `${baseUrl}/sub/${type}/${encodeURIComponent(cleanId)}.srt`;

  subtitles.push({
    id: `groq_sq_${cleanId}`,
    url: subPath,
    lang: 'sqi',
    label: '🇦🇱 Shqip (Groq AI Fast)'
  });

  // 2. Fetch native Albanian subtitles from OpenSubtitles (if already available)
  try {
    const available = await fetchAvailableSubtitles(type, cleanId);
    const nativeAlbanian = findExistingAlbanianSubtitles(available);

    nativeAlbanian.forEach((item, index) => {
      subtitles.push({
        id: `os_sq_${index}_${cleanId}`,
        url: item.url,
        lang: 'sqi',
        label: `🇦🇱 Shqip (OpenSubtitles ${item.label ? `[${item.label}]` : 'Original'})`
      });
    });
  } catch (err) {
    console.warn(`[Subtitles] Could not query OpenSubtitles: ${err.message}`);
  }

  res.setHeader('Cache-Control', 'max-age=3600, public');
  res.json({ subtitles });
}

// Subtitles list endpoints (supports optional extra parameters like videoHash)
app.get([
  '/subtitles/:type/:id.json',
  '/subtitles/:type/:id/:extra.json'
], (req, res) => {
  handleSubtitlesList(req, res, null);
});

app.get([
  '/:config/subtitles/:type/:id.json',
  '/:config/subtitles/:type/:id/:extra.json'
], (req, res) => {
  handleSubtitlesList(req, res, req.params.config);
});

// Subtitle translation and delivery handler
async function handleDeliverSubtitle(req, res, configStr) {
  const { type, id } = req.params;
  const cleanId = cleanStremioId(id);
  const cacheKey = `${type}_${cleanId}_sq`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Check disk cache first
  const cachedSrt = cache.get(cacheKey);
  if (cachedSrt) {
    console.log(`[Delivery] Serving cached translation for ${cleanId}`);
    return res.send(cachedSrt);
  }

  // If already translating, await the in-flight promise
  const inFlight = cache.getInFlight(cacheKey);
  if (inFlight) {
    console.log(`[Delivery] Awaiting in-flight translation for ${cleanId}`);
    try {
      const result = await inFlight;
      return res.send(result);
    } catch (err) {
      return res.status(500).send(`1\n00:00:01,000 --> 00:00:10,000\nGabim gjatë përkthimit: ${err.message}\n`);
    }
  }

  // Start new translation process
  const translationPromise = (async () => {
    // 1. Fetch available subtitles to find English source
    console.log(`[Delivery] Fetching source subtitle for ${type}/${cleanId}...`);
    const available = await fetchAvailableSubtitles(type, cleanId);
    const bestEng = findBestEnglishSubtitle(available);

    if (!bestEng || !bestEng.url) {
      throw new Error('Nuk u gjet asnjë titër në anglisht në OpenSubtitles për këtë përmbajtje.');
    }

    // 2. Download English raw SRT
    const englishSrt = await downloadSrt(bestEng.url);

    // 3. Parse user configuration
    const userConfig = parseConfig(configStr);
    const translationConfig = {
      groqApiKey: userConfig.key || process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY,
      model: userConfig.model || process.env.GROQ_MODEL || DEFAULT_MODEL
    };

    // 4. Translate with Groq
    const translatedSrt = await translateSrtToAlbanian(englishSrt, translationConfig);

    // 5. Store in persistent cache
    cache.set(cacheKey, translatedSrt);

    return translatedSrt;
  })();

  cache.setInFlight(cacheKey, translationPromise);

  try {
    const srt = await translationPromise;
    return res.send(srt);
  } catch (err) {
    console.error(`[Delivery] Translation failed for ${cleanId}:`, err.message);
    const errorSrt = `1\n00:00:01,000 --> 00:00:10,000\n[Titra Shqip AI]: ${err.message}\nJu lutem kontrolloni çelësin Groq API te /configure.\n`;
    return res.status(200).send(errorSrt);
  }
}

// Deliver subtitle endpoints (.srt)
app.get('/sub/:type/:id.srt', (req, res) => {
  handleDeliverSubtitle(req, res, null);
});

app.get('/sub/:config/:type/:id.srt', (req, res) => {
  handleDeliverSubtitle(req, res, req.params.config);
});

// Start server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🇦🇱 Stremio Titra Shqip AI Addon running on port ${PORT}`);
  console.log(`Configuration URL: http://localhost:${PORT}/configure`);
  console.log(`Manifest URL:      http://localhost:${PORT}/manifest.json`);
  console.log(`=======================================================`);
});
