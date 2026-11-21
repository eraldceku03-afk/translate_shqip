# 🇦🇱 Titra Shqip AI me Groq - Stremio Addon

Një Addon modern për **Stremio** që përkthen automatikisht titrat e filmave dhe serialeve në **Gjuhën Shqipe** duke përdorur **Groq AI (Llama 3.1 / 3.3)**.

Është i dizajnuar posaçërisht për t'u ngritur **falas në Render.com** dhe zgjidh problemin e limiteve (rate-limits).

---

## ⚡ Pse nuk ka kufizime (Zero Limite)?

1. **Multi-Key Pool & Rotation**:
   Mund të vendosësh disa çelësa Groq API të ndarë me presje (`key1,key2,key3`). Nëse një çelës arrin limitin e minutës, addon-i kalon automatikisht te çelësi tjetër pa ndërprerë filmin.
2. **Persistent Caching**:
   Sapo një film ose episod përkthehet një herë, skedari `.srt` ruhet në Cache. Hera e dytë që shikohet nga ju apo dikush tjetër ngarkohet në **0 sekonda** me **0 thirrje API**.
3. **Modeli Llama 3.1 8B Instant**:
   Ky model në Groq ka shpejtësi marramendëse (~800 fjalë/sekondë) dhe limite shumë të larta në planin falas (deri në 500,000 kërkesa në ditë). Përkthen një film të plotë 2-orësh në rreth 15–20 sekonda.
4. **Faqe Konfigurimi Personale (`/configure`)**:
   Çdo përdorues mund të vendosë çelësin e vet falas direkt nga shfletuesi, pa prekur kodin e serverit.

---

## 🔑 Hapi 1: Merrni Groq API Key (Falas)

1. Shkoni te [console.groq.com](https://console.groq.com) dhe regjistrohuni me llogarinë tuaj Google ose Email.
2. Shkoni te seksioni **API Keys** ose klikoni [këtu](https://console.groq.com/keys).
3. Klikoni **"Create API Key"**, vendosni një emër (p.sh. `stremio`) dhe kopjoni çelësin (fillon me `gsk_...`).
> **Këshillë:** Mund të krijoni 2 ose 3 çelësa për t'i vendosur bashkë me presje për performancë të pakufizuar.

---

## 🚀 Hapi 2: Publikimi në Render.com (Online & Falas)

### Metoda A: Me GitHub (Më e lehta)

1. Krijoni një llogari falas në [GitHub.com](https://github.com) dhe [Render.com](https://render.com).
2. Krijoni një Repository të ri në GitHub dhe ngarkoni skedarët e këtij projekti.
3. Në **Render Dashboard**:
   - Klikoni **New +** -> **Web Service**.
   - Zgjidhni repository-n tuaj në GitHub.
   - Plotësoni këto cilësime:
     - **Name**: `stremio-titra-shqip`
     - **Language / Runtime**: `Node`
     - **Build Command**: `npm install`
     - **Start Command**: `npm start`
     - **Instance Type**: `Free`
   - Shkoni poshtë te **Environment Variables** dhe shtoni:
     - `GROQ_API_KEYS` = `gsk_çelësi_juaj` (ose disa çelësa të ndarë me presje: `gsk_1,gsk_2`)
     - `GROQ_MODEL` = `llama-3.1-8b-instant`
   - Klikoni **Deploy Web Service**.

Brenda 1-2 minutash, Render do t'ju japë një link publik, p.sh.:
`https://stremio-titra-shqip.onrender.com`

---

## 📺 Hapi 3: Instalimi në Stremio

1. Hapni në shfletues linkun e Render-it:
   `https://emri-juaj.onrender.com/configure`
2. Nëse dëshironi, shënoni çelësin tuaj Groq API ose zgjidhni modelin.
3. Klikoni butonin e madh **"Instalo në Stremio"**.
   - Nëse jeni në PC ose Android me aplikacionin e instaluar, Stremio do të hapet automatikisht dhe do t'ju kërkojë të konfirmoni instalimin.
   - Nëse jeni në **Smart TV** ose **Stremio Web**: Klikoni **"Kopjo Manifest URL"**, shkoni te Stremio -> Addons -> ngjisni linkun te kutia e kërkimit dhe shtypni Enter.

---

## 🛠️ Testimi Lokal (nëse dëshironi ta provoni në kompjuter)

```bash
# Instaloni varësitë
npm install

# Kopjoni shembullin e konfigurimit
cp .env.example .env
# Vendosni GROQ_API_KEYS në skedarin .env

# Nisni serverin
npm start
```

Hapni `http://localhost:7000/configure` në shfletues.

---

## 📁 Struktura e Projektit

```text
├── public/
│   └── configure.html       # Faqja moderne e konfigurimit
├── services/
│   ├── cache.js             # Ruajtja e titrave në disk
│   ├── opensubtitles.js     # Gjetja e titrave burim zyrtarë
│   ├── srtParser.js         # Leximi dhe formatimi i skedarëve .srt
│   └── translator.js        # Motori i përkthimit me Groq AI & Key Rotation
├── Dockerfile               # Për containerizim Docker
├── render.yaml              # Render Blueprint për deploy automatik
├── server.js                # Serveri Express me protokollin e Stremio-s
└── package.json
```

---

## 🇦🇱 Karakteristikat Gjuhësore
Prompti i Groq AI është i kalibruar posaçërisht për filma:
- Përkthen frazat idiomatike dhe zhargonin e përditshëm në mënyrë natyrale dhe jo fjalë-për-fjalë mekanike.
- Ruan sinkronizimin ekzakt të sekondave me dialogun origjinal.
- Nuk dëmton formatimin e titrave.
