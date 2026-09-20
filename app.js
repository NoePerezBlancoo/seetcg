const TCGDEX = 'https://api.tcgdex.net/v2'
const COLLECTION_KEY = 'seetcg:collection:v1'
const FX_KEY = 'seetcg:fx:v1'

const state = {
  tab: 'scan',
  lang: 'auto',
  detectedLang: 'es',
  file: null,
  preview: '',
  ocrText: '',
  candidates: [],
  selected: null,
  selectedVariant: 'normal',
  collection: loadCollection(),
  busy: false,
  toast: '',
}

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[char])
}

function cardImage(image, quality = 'high') {
  return image ? `${image}/${quality}.webp` : ''
}

function money(value, currency = 'EUR') {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(Number(value))
}

function loadCollection() {
  try {
    const value = JSON.parse(localStorage.getItem(COLLECTION_KEY) || '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function saveCollection() {
  localStorage.setItem(COLLECTION_KEY, JSON.stringify(state.collection))
}

function totalCards() {
  return state.collection.reduce((sum, item) => sum + item.quantity, 0)
}

function totalValue() {
  return state.collection.reduce((sum, item) => sum + (item.priceSnapshot || 0) * item.quantity, 0)
}

async function json(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`La fuente de datos respondió ${response.status}`)
  return response.json()
}

function activeCatalogLang() {
  return state.lang === 'auto' ? (state.detectedLang || 'es') : state.lang
}

async function searchCards(query = '', number = '', limit = 30, lang = activeCatalogLang()) {
  const params = new URLSearchParams()
  if (query.trim()) params.set('name', query.trim())
  if (number.trim()) params.set('localId', `eq:${number.trim()}`)
  params.set('pagination:page', '1')
  params.set('pagination:itemsPerPage', String(limit))
  return json(`${TCGDEX}/${lang}/cards?${params}`)
}

async function getCard(id, lang = activeCatalogLang()) {
  return json(`${TCGDEX}/${lang}/cards/${encodeURIComponent(id)}`)
}

const STOP = new Set([
  'basic','stage','trainer','energy','pokemon','pokémon','attack','weakness',
  'resistance','retreat','illus','rule','ability','debilidad','resistencia',
  'retirada','entrenador','energía','energia','habilidad','regla','basico','básico',
])

function detectOcrLanguage(text) {
  if (/[\u3040-\u30ff\u3400-\u9fff]/u.test(text)) return 'ja'
  return 'es'
}

function ocrTokens(text) {
  const latin = text.toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9\s-]/gi, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4 && word.length <= 18)
    .filter((word) => !STOP.has(word) && !/^\d+$/.test(word))

  const japanese = text
    .split(/\r?\n/)
    .flatMap((line) => line.match(/[\u3040-\u30ff\u3400-\u9fffー]{2,12}/gu) || [])
    .filter((word) => word.length >= 2 && word.length <= 12)

  return [...new Set([...japanese, ...latin])].slice(0, 10)
}

function cardNumber(text) {
  const match = text.replace(/[|lI]/g, '/').match(/\b([A-Z]{0,3}\d{1,4})\s*\/\s*(\d{1,4})\b/i)
  return match?.[1] || ''
}

function candidateScore(card, text, tokens, number) {
  let score = 0
  const lower = text.toLowerCase()
  if (number && String(card.localId).toLowerCase() === number.toLowerCase()) score += 14
  if (lower.includes(String(card.name).toLowerCase())) score += 12
  tokens.forEach((token) => {
    if (String(card.name).toLowerCase().includes(token)) score += token.length >= 7 ? 4 : 2
  })
  return score
}

async function candidatesFromOcr(text) {
  const number = cardNumber(text)
  const tokens = ocrTokens(text)
  const detected = detectOcrLanguage(text)
  state.detectedLang = detected
  const languages = state.lang === 'auto'
    ? (detected === 'ja' ? ['ja'] : ['es', 'en'])
    : [state.lang]
  const bucket = new Map()

  for (const lang of languages) {
    if (number) {
      try {
        ;(await searchCards('', number, 100, lang)).forEach((card) => {
          bucket.set(`${lang}:${card.id}`, { ...card, _lang: lang })
        })
      } catch {}
    }

    const groups = await Promise.all(tokens.slice(0, 6).map(async (token) => {
      try {
        return (await searchCards(token, '', 40, lang)).map((card) => ({ ...card, _lang: lang }))
      } catch {
        return []
      }
    }))
    groups.flat().forEach((card) => bucket.set(`${lang}:${card.id}`, card))
  }

  const scored = [...bucket.values()]
    .map((card) => ({ ...card, _score: candidateScore(card, text, tokens, number) }))
    .sort((a, b) => b._score - a._score)

  const best = scored[0]?._score || 0
  if (best < 4) return []
  return scored
    .filter((card) => card._score >= Math.max(4, best - 6))
    .slice(0, 12)
}

async function usdEur() {
  try {
    const cached = JSON.parse(localStorage.getItem(FX_KEY) || 'null')
    if (cached?.rate && Date.now() - cached.at < 12 * 60 * 60 * 1000) return cached.rate
  } catch {}

  try {
    const data = await json('https://api.frankfurter.dev/v2/rate/usd/eur')
    const rate = Number(data.rate)
    if (!Number.isFinite(rate)) return null
    localStorage.setItem(FX_KEY, JSON.stringify({ rate, at: Date.now() }))
    return rate
  } catch {
    return null
  }
}

function variants(card) {
  const v = card?.variants || {}
  const list = []
  if (v.normal) list.push(['normal', 'Normal'])
  if (v.reverse) list.push(['reverse', 'Reverse holo'])
  if (v.holo) list.push(['holo', 'Holo'])
  if (v.firstEdition) list.push(['firstEdition', '1ª edición'])
  return list.length ? list : [['normal', 'Estándar']]
}

function tcgVariant(pricing, variant) {
  if (!pricing) return null
  const aliases = {
    normal: ['normal', 'unlimited'],
    reverse: ['reverse', 'reverse-holofoil'],
    holo: ['holo', 'holofoil', 'unlimited-holofoil'],
    firstEdition: ['1st-edition', '1st-edition-holofoil'],
  }
  return (aliases[variant] || aliases.normal).map((key) => pricing[key]).find(Boolean) || null
}

function median(values) {
  const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!list.length) return null
  const mid = Math.floor(list.length / 2)
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2
}

function market(card, variant, rate) {
  const cm = card?.pricing?.cardmarket
  const tp = tcgVariant(card?.pricing?.tcgplayer, variant)
  const holo = variant === 'holo' || variant === 'firstEdition'
  const cmRef = Number(holo ? (cm?.['trend-holo'] ?? cm?.['avg7-holo'] ?? cm?.['avg-holo']) : (cm?.trend ?? cm?.avg7 ?? cm?.avg))
  const cmLow = Number(holo ? cm?.['low-holo'] : cm?.low)
  const tpRefUsd = Number(tp?.marketPrice ?? tp?.midPrice)
  const tpLowUsd = Number(tp?.lowPrice)
  const tpHighUsd = Number(tp?.highPrice)

  const good = (n) => Number.isFinite(n) && n > 0
  const cmRefOk = good(cmRef) ? cmRef : null
  const cmLowOk = good(cmLow) ? cmLow : null
  const tpRefOk = good(tpRefUsd) ? tpRefUsd : null
  const tpLowOk = good(tpLowUsd) ? tpLowUsd : null
  const tpHighOk = good(tpHighUsd) ? tpHighUsd : null
  const tpRefEur = tpRefOk && rate ? tpRefOk * rate : null
  const tpLowEur = tpLowOk && rate ? tpLowOk * rate : null
  const tpHighEur = tpHighOk && rate ? tpHighOk * rate : null

  const estimate = median([cmRefOk, tpRefEur])
  const lows = [cmLowOk, tpLowEur].filter((x) => x != null)
  const highs = [cmRefOk, tpRefEur, tpHighEur].filter((x) => x != null)

  return {
    estimate,
    low: lows.length ? Math.min(...lows) : null,
    high: highs.length ? Math.max(...highs) : null,
    sources: [
      cmRefOk ? { name: 'Cardmarket', currency: 'EUR', ref: cmRefOk, low: cmLowOk, note: holo ? 'Tendencia holo' : 'Tendencia / media' } : null,
      tpRefOk ? { name: 'TCGplayer', currency: 'USD', ref: tpRefOk, low: tpLowOk, note: rate ? `1 USD = ${rate.toFixed(4)} EUR` : 'Conversión EUR no disponible' } : null,
    ].filter(Boolean),
  }
}

function nav() {
  return `
    <header class="topbar">
      <button class="brand" data-tab="scan"><span class="brand-mark">S</span><span><strong>SeeTCG</strong><small>Scan · Identify · Value</small></span></button>
      <nav class="desktop-nav">
        <button data-tab="scan" class="${state.tab === 'scan' ? 'active' : ''}">Escanear</button>
        <button data-tab="search" class="${state.tab === 'search' ? 'active' : ''}">Buscar</button>
        <button data-tab="collection" class="${state.tab === 'collection' ? 'active' : ''}">Colección <span class="count">${totalCards()}</span></button>
      </nav>
    </header>`
}

function bottomNav() {
  return `<nav class="bottom-nav">
    <button data-tab="scan" class="${state.tab === 'scan' ? 'active' : ''}"><b>⌁</b><span>Escanear</span></button>
    <button data-tab="search" class="${state.tab === 'search' ? 'active' : ''}"><b>⌕</b><span>Buscar</span></button>
    <button data-tab="collection" class="${state.tab === 'collection' ? 'active' : ''}"><b>◇</b><span>Colección · ${totalCards()}</span></button>
  </nav>`
}

function candidateGrid(cards, title = 'Posibles coincidencias') {
  if (!cards.length) return ''
  return `<section class="candidate-section">
    <div class="section-heading"><div><span class="eyebrow">IDENTIFICACIÓN</span><h2>${escapeHtml(title)}</h2></div><span class="muted">${cards.length} resultados</span></div>
    <div class="candidate-grid">${cards.map((card) => `
      <button class="candidate-card" data-card-id="${escapeHtml(card.id)}" data-card-lang="${escapeHtml(card._lang || activeCatalogLang())}">
        <img src="${escapeHtml(cardImage(card.image, 'low'))}" alt="${escapeHtml(card.name)}" loading="lazy">
        <span><strong>${escapeHtml(card.name)}</strong><small>#${escapeHtml(card.localId)}</small></span>
      </button>`).join('')}</div>
  </section>`
}

function scanView() {
  return `<main class="page">
    <section class="hero">
      <div class="hero-copy">
        <span class="eyebrow">ESCÁNER TCG</span>
        <h1>Apunta. Identifica.<br><span>Conoce su valor.</span></h1>
        <p>Fotografía una carta Pokémon. SeeTCG lee su nombre y numeración, contrasta el catálogo y calcula una referencia de mercado.</p>
        <div class="trust-row"><span>● Cardmarket</span><span>● TCGplayer</span><span>● FX diario</span></div>
      </div>
      <div class="scanner-card">
        <div class="scanner-top"><div><strong>Cámara / imagen</strong><small>Carta recta, sin reflejos y ocupando el encuadre</small></div>
          <select id="scan-lang"><option value="auto" ${state.lang === 'auto' ? 'selected' : ''}>AUTO</option><option value="es" ${state.lang === 'es' ? 'selected' : ''}>ES</option><option value="en" ${state.lang === 'en' ? 'selected' : ''}>EN</option><option value="ja" ${state.lang === 'ja' ? 'selected' : ''}>日本語</option></select>
        </div>
        <button class="dropzone" id="pick-image">${state.preview
          ? `<img src="${escapeHtml(state.preview)}" alt="Carta seleccionada">`
          : `<div class="drop-content"><span class="camera-glyph">⌾</span><strong>Fotografiar una carta</strong><small>Usa la cámara trasera o selecciona una imagen</small></div>`}</button>
        <input id="image-input" class="sr-only" type="file" accept="image/*" capture="environment">
        <div id="progress-slot"></div>
        <button class="primary-button" id="scan-button"><span>${state.file ? 'Identificar carta' : 'Abrir cámara'}</span><span>→</span></button>
        ${state.ocrText ? `<details class="ocr-details"><summary>Ver texto detectado</summary><pre>${escapeHtml(state.ocrText)}</pre></details>` : ''}
      </div>
    </section>
    ${candidateGrid(state.candidates)}
  </main>`
}

function searchView() {
  return `<main class="page narrow-page">
    <section class="search-hero">
      <span class="eyebrow">CATÁLOGO POKÉMON</span><h1>Encuentra una carta</h1>
      <p>Busca por nombre, por número de colección o combina ambos para afinar el resultado.</p>
      <form class="search-form" id="search-form">
        <label><span>Nombre</span><input id="query" placeholder="Ej. Charizard, Pikachu…"></label>
        <label><span>Número</span><input id="number" placeholder="199"></label>
        <label><span>Idioma</span><select id="search-lang"><option value="es" ${state.lang === 'es' || state.lang === 'auto' ? 'selected' : ''}>ES</option><option value="en" ${state.lang === 'en' ? 'selected' : ''}>EN</option><option value="ja" ${state.lang === 'ja' ? 'selected' : ''}>日本語</option></select></label>
        <button class="primary-button compact">Buscar</button>
      </form>
      <div id="search-message"></div>
    </section>
    <div id="search-results"></div>
  </main>`
}

function collectionView() {
  return `<main class="page narrow-page">
    <section class="collection-hero">
      <div><span class="eyebrow">MI COLECCIÓN</span><h1>${state.collection.length ? `${state.collection.length} posiciones` : 'Tu colección empieza aquí'}</h1>
      <p>Los valores guardados son una fotografía del precio estimado en el momento de añadir cada carta.</p></div>
      <div class="portfolio-value"><span>VALOR REGISTRADO</span><strong>${money(totalValue())}</strong></div>
    </section>
    ${!state.collection.length ? `<div class="empty-state"><span>◇</span><h2>Aún no has guardado cartas</h2><p>Escanea o busca una carta y añádela desde su ficha.</p></div>`
      : `<div class="collection-list">${state.collection.map((item) => `
        <article class="collection-row">
          <img src="${escapeHtml(cardImage(item.image, 'low'))}" alt="${escapeHtml(item.name)}">
          <div class="collection-main"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.setName)} · #${escapeHtml(item.localId)} · ${escapeHtml(item.variant)}</small></div>
          <div class="quantity"><button data-dec="${escapeHtml(item.key)}">−</button><span>${item.quantity}</span><button data-inc="${escapeHtml(item.key)}">+</button></div>
          <div class="collection-price"><strong>${money((item.priceSnapshot || 0) * item.quantity)}</strong><small>${money(item.priceSnapshot)} / ud.</small></div>
          <button class="delete-button" data-del="${escapeHtml(item.key)}">×</button>
        </article>`).join('')}</div>`}
  </main>`
}

function footer() {
  return `<footer><span>SeeTCG MVP · Pokémon</span><span>Catálogo/precios: TCGdex · FX: Frankfurter</span></footer>`
}

function render() {
  const view = state.tab === 'scan' ? scanView() : state.tab === 'search' ? searchView() : collectionView()
  $('#app').innerHTML = `${nav()}${view}${footer()}${bottomNav()}${state.selected ? '<div id="modal-root"></div>' : ''}${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ''}`
  bindCommon()
  if (state.tab === 'scan') bindScanner()
  if (state.tab === 'search') bindSearch()
  if (state.tab === 'collection') bindCollection()
  if (state.selected) renderModal()
}

function bindCommon() {
  $$('[data-tab]').forEach((button) => button.addEventListener('click', () => {
    state.tab = button.dataset.tab
    render()
  }))
  $('[data-card-id]').forEach((button) => button.addEventListener('click', () => openCard(button.dataset.cardId, button.dataset.cardLang)))
}

function bindScanner() {
  $('#scan-lang')?.addEventListener('change', (e) => { state.lang = e.target.value })
  $('#pick-image')?.addEventListener('click', () => $('#image-input').click())
  $('#image-input')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (state.preview) URL.revokeObjectURL(state.preview)
    state.file = file
    state.preview = URL.createObjectURL(file)
    state.candidates = []
    state.ocrText = ''
    render()
  })
  $('#scan-button')?.addEventListener('click', runScan)
}

function progress(status, value) {
  const slot = $('#progress-slot')
  if (!slot) return
  slot.innerHTML = `<div class="progress-wrap"><div class="progress-meta"><span>${escapeHtml(status)}</span><span>${Math.round((value || 0) * 100)}%</span></div><div class="progress"><span style="width:${Math.round((value || 0) * 100)}%"></span></div></div>`
}

async function runScan() {
  if (!state.file) {
    $('#image-input')?.click()
    return
  }
  if (!window.Tesseract) {
    progress('No se pudo cargar el motor OCR', 0)
    return
  }

  try {
    progress('Preparando OCR…', .04)
    const ocrLang = state.lang === 'ja' ? 'jpn+eng' : state.lang === 'en' ? 'eng' : state.lang === 'es' ? 'spa+eng' : 'jpn+spa+eng'
    const result = await window.Tesseract.recognize(state.file, ocrLang, {
      logger: (message) => {
        if (message.status === 'recognizing text') progress('Leyendo la carta…', message.progress || .1)
      },
    })
    state.ocrText = result?.data?.text?.trim() || ''
    if (!state.ocrText) throw new Error('No se ha podido extraer texto.')
    progress('Buscando coincidencias…', .92)
    state.candidates = await candidatesFromOcr(state.ocrText)
    render()
    if (!state.candidates.length) showToast('Sin coincidencias claras. Prueba otra foto o la búsqueda manual.')
  } catch (error) {
    progress(error.message || 'No se ha podido analizar la carta', 0)
  }
}

function bindSearch() {
  $('#search-form')?.addEventListener('submit', async (e) => {
    e.preventDefault()
    state.lang = $('#search-lang').value
    const query = $('#query').value
    const number = $('#number').value
    if (!query.trim() && !number.trim()) return
    const results = $('#search-results')
    const message = $('#search-message')
    message.innerHTML = '<div class="progress-wrap"><div class="progress-meta"><span>Buscando catálogo…</span></div></div>'
    try {
      const cards = await searchCards(query, number, 30)
      message.innerHTML = ''
      results.innerHTML = candidateGrid(cards, 'Resultados del catálogo')
      $('[data-card-id]', results).forEach((button) => button.addEventListener('click', () => openCard(button.dataset.cardId, button.dataset.cardLang)))
    } catch (error) {
      message.innerHTML = `<div class="alert">${escapeHtml(error.message)}</div>`
    }
  })
}

async function openCard(id, lang = activeCatalogLang()) {
  showBusy(true)
  try {
    state.detectedLang = lang || state.detectedLang
    state.selected = await getCard(id, lang)
    state.selectedVariant = variants(state.selected)[0][0]
    render()
  } catch {
    showToast('No se pudo cargar la ficha de la carta.')
  } finally {
    showBusy(false)
  }
}

async function renderModal() {
  const card = state.selected
  const root = $('#modal-root')
  if (!root || !card) return
  const rate = await usdEur()
  const data = market(card, state.selectedVariant, rate)

  root.innerHTML = `<div class="modal-backdrop" id="modal-backdrop"><section class="detail-modal">
    <button class="close-button" id="close-modal">×</button>
    <div class="detail-grid">
      <div class="detail-art"><img src="${escapeHtml(cardImage(card.image))}" alt="${escapeHtml(card.name)}"></div>
      <div class="detail-info">
        <span class="eyebrow">${escapeHtml(card.set?.name || 'POKÉMON TCG')}</span>
        <h2>${escapeHtml(card.name)}</h2>
        <p class="card-meta">#${escapeHtml(card.localId)} · ${escapeHtml(card.rarity || 'Rareza no indicada')} · ${escapeHtml(card.category || '')}</p>
        <label class="variant-select"><span>Variante</span><select id="variant-select">${variants(card).map(([value,label]) => `<option value="${value}" ${value === state.selectedVariant ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <div class="market-highlight"><span>VALOR DE MERCADO ESTIMADO</span><strong>${money(data.estimate)}</strong>
          <div><small>Bajo <b>${money(data.low)}</b></small><small>Alto <b>${money(data.high)}</b></small><small>Fuentes <b>${data.sources.length}</b></small></div>
        </div>
        <p class="estimate-note">Mediana de referencias comparables disponibles. El estado físico, idioma y grading pueden cambiar mucho el valor real.</p>
        <div class="source-list">${data.sources.length ? data.sources.map((source) => `<article class="source-card"><div><strong>${source.name}</strong><small>${escapeHtml(source.note)}</small></div><div class="source-price"><strong>${money(source.ref, source.currency)}</strong><small>mín. ${money(source.low, source.currency)}</small></div></article>`).join('') : '<div class="empty-inline">No hay precios disponibles para esta carta/variante.</div>'}</div>
        <button class="primary-button" id="add-card">Añadir a mi colección</button>
      </div>
    </div>
  </section></div>`

  $('#close-modal')?.addEventListener('click', closeModal)
  $('#modal-backdrop')?.addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') closeModal() })
  $('#variant-select')?.addEventListener('change', (e) => { state.selectedVariant = e.target.value; renderModal() })
  $('#add-card')?.addEventListener('click', () => addCard(card, data))
}

function closeModal() {
  state.selected = null
  render()
}

function addCard(card, data) {
  const key = `${card.id}:${state.selectedVariant}`
  const existing = state.collection.find((item) => item.key === key)
  if (existing) {
    existing.quantity += 1
    existing.priceSnapshot = data.estimate
  } else {
    state.collection.unshift({
      key,
      cardId: card.id,
      name: card.name,
      localId: String(card.localId),
      setName: card.set?.name || 'Set desconocido',
      image: card.image,
      variant: state.selectedVariant,
      quantity: 1,
      priceSnapshot: data.estimate,
      addedAt: new Date().toISOString(),
    })
  }
  saveCollection()
  showToast(`${card.name} añadida a tu colección`)
  render()
}

function bindCollection() {
  $$('[data-inc]').forEach((button) => button.addEventListener('click', () => changeQty(button.dataset.inc, 1)))
  $$('[data-dec]').forEach((button) => button.addEventListener('click', () => changeQty(button.dataset.dec, -1)))
  $$('[data-del]').forEach((button) => button.addEventListener('click', () => {
    state.collection = state.collection.filter((item) => item.key !== button.dataset.del)
    saveCollection()
    render()
  }))
}

function changeQty(key, delta) {
  const item = state.collection.find((entry) => entry.key === key)
  if (!item) return
  item.quantity += delta
  if (item.quantity <= 0) state.collection = state.collection.filter((entry) => entry.key !== key)
  saveCollection()
  render()
}

function showBusy(show) {
  let overlay = $('#busy-overlay')
  if (show && !overlay) {
    overlay = document.createElement('div')
    overlay.id = 'busy-overlay'
    overlay.className = 'loading-overlay'
    overlay.innerHTML = '<span class="spinner"></span><strong>Cargando mercado…</strong>'
    document.body.append(overlay)
  } else if (!show) {
    overlay?.remove()
  }
}

function showToast(message) {
  state.toast = message
  render()
  setTimeout(() => {
    state.toast = ''
    render()
  }, 2400)
}

render()

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}))
}
