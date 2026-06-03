const crypto = require('crypto')
const axios = require('axios')
const supabase = require('../config/supabase')

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-10'

const shopifyConfig = () => ({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecret: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SHOPIFY_SCOPES || 'read_products',
  appUrl: (process.env.SHOPIFY_APP_URL || process.env.APP_URL || '').replace(/\/$/, '')
})

const isValidShopDomain = shop => (
  typeof shop === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)
)

const signState = shop => {
  const { apiSecret } = shopifyConfig()
  const payload = JSON.stringify({
    shop,
    nonce: crypto.randomBytes(12).toString('hex'),
    ts: Date.now()
  })
  const encoded = Buffer.from(payload).toString('base64url')
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(encoded)
    .digest('hex')

  return `${encoded}.${signature}`
}

const signShopToken = (shop, purpose) => {
  const { apiSecret } = shopifyConfig()
  const payload = JSON.stringify({
    shop,
    purpose,
    ts: Date.now()
  })
  const encoded = Buffer.from(payload).toString('base64url')
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(encoded)
    .digest('hex')

  return `${encoded}.${signature}`
}

const verifyShopToken = (token, shop, purpose, maxAgeMs = 24 * 60 * 60 * 1000) => {
  const { apiSecret } = shopifyConfig()
  if (!token || !token.includes('.')) return false

  const [encoded, signature] = token.split('.')
  const expected = crypto
    .createHmac('sha256', apiSecret)
    .update(encoded)
    .digest('hex')

  const signatureBuffer = Buffer.from(signature || '')
  const expectedBuffer = Buffer.from(expected)

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return false
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    const ageMs = Date.now() - payload.ts
    return payload.shop === shop &&
      payload.purpose === purpose &&
      ageMs >= 0 &&
      ageMs < maxAgeMs
  } catch (error) {
    return false
  }
}

const verifyState = (state, shop) => {
  const { apiSecret } = shopifyConfig()
  if (!state || !state.includes('.')) return false

  const [encoded, signature] = state.split('.')
  const expected = crypto
    .createHmac('sha256', apiSecret)
    .update(encoded)
    .digest('hex')

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return false
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    const ageMs = Date.now() - payload.ts
    return payload.shop === shop && ageMs >= 0 && ageMs < 10 * 60 * 1000
  } catch (error) {
    return false
  }
}

const verifyShopifyHmac = query => {
  const { apiSecret } = shopifyConfig()
  const { hmac, signature, ...params } = query
  if (!hmac) return false

  const message = Object.keys(params)
    .sort()
    .map(key => `${key}=${Array.isArray(params[key]) ? params[key].join(',') : params[key]}`)
    .join('&')

  const digest = crypto
    .createHmac('sha256', apiSecret)
    .update(message)
    .digest('hex')

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac))
}

const shopSlug = shop => shop.replace('.myshopify.com', '').toLowerCase()

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

const maskKey = key => {
  if (!key) return 'Not configured'
  if (key.length <= 12) return key
  return `${key.slice(0, 8)}...${key.slice(-4)}`
}

const themeEditorUrl = shop => `https://${shop}/admin/themes/current/editor?context=apps`
const storefrontUrl = shop => `https://${shop}`
const isValidHexColor = value => /^#[0-9a-fA-F]{6}$/.test(value)
const normalizeBrandCategory = value => String(value || 'general')
  .trim()
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .slice(0, 80)

const stripHtml = value => String(value || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

const parseShopifyTags = tags => String(tags || '')
  .split(',')
  .map(tag => tag.trim())
  .filter(Boolean)
  .filter((tag, index, all) => all.findIndex(item => item.toLowerCase() === tag.toLowerCase()) === index)

const parseLinkHeader = linkHeader => {
  if (!linkHeader) return null

  const nextLink = linkHeader
    .split(',')
    .map(part => part.trim())
    .find(part => part.includes('rel="next"'))

  return nextLink?.match(/<([^>]+)>/)?.[1] || null
}

const fetchShopifyProducts = async (shop, accessToken) => {
  const products = []
  let nextUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=250`

  while (nextUrl) {
    const response = await axios.get(nextUrl, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        Accept: 'application/json'
      }
    })

    products.push(...(response.data?.products || []))
    nextUrl = parseLinkHeader(response.headers.link)
  }

  return products
}

const shopifyProductUrl = (shop, product) => (
  product.handle ? `https://${shop}/products/${product.handle}` : null
)

const buildProductPayload = (shop, brand, product) => {
  const tags = parseShopifyTags(product.tags)
  const firstVariant = product.variants?.[0]
  const price = Number(firstVariant?.price || 0)
  const imageUrl = product.image?.src || product.images?.[0]?.src || null
  const category = String(product.product_type || brand.product_category || 'general').trim() || 'general'

  return {
    brand_id: brand.brand_id,
    name: product.title || 'Untitled product',
    category,
    description: stripHtml(product.body_html),
    usage_step: category,
    time_of_day: 'As needed',
    how_to_use: 'Use as directed by the brand.',
    price: Number.isFinite(price) ? price : 0,
    image_url: imageUrl,
    product_url: shopifyProductUrl(shop, product),
    suitable_skin_types: tags,
    is_active: product.status !== 'archived'
  }
}

const getExistingProductId = async (brandId, payload) => {
  let query = supabase
    .from('products')
    .select('product_id')
    .eq('brand_id', brandId)
    .limit(1)

  query = payload.product_url
    ? query.eq('product_url', payload.product_url)
    : query.eq('name', payload.name)

  const { data, error } = await query.maybeSingle()
  if (error) throw error

  return data?.product_id || null
}

const ensureProductConcernTags = async (productId, product, payload) => {
  const { count, error: countError } = await supabase
    .from('concern_tags')
    .select('product_id', { count: 'exact', head: true })
    .eq('product_id', productId)

  if (countError) throw countError
  if (count) return

  const tags = parseShopifyTags(product.tags)
  const concerns = [
    ...tags,
    product.product_type,
    product.vendor,
    payload.category
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .filter((value, index, all) => all.findIndex(item => item.toLowerCase() === value.toLowerCase()) === index)
    .slice(0, 8)

  if (!concerns.length) return

  const { error } = await supabase
    .from('concern_tags')
    .insert(concerns.map((concern, index) => ({
      product_id: productId,
      concern,
      severity_level: 3,
      priority_score: Math.max(1, 8 - index)
    })))

  if (error) throw error
}

const saveShopifyProducts = async (shop, brand, shopifyProducts) => {
  let savedCount = 0

  for (const shopifyProduct of shopifyProducts) {
    const payload = buildProductPayload(shop, brand, shopifyProduct)
    const existingProductId = await getExistingProductId(brand.brand_id, payload)

    const write = existingProductId
      ? supabase
        .from('products')
        .update(payload)
        .eq('product_id', existingProductId)
        .select('product_id')
        .single()
      : supabase
        .from('products')
        .insert(payload)
        .select('product_id')
        .single()

    const { data, error } = await write
    if (error) throw error

    await ensureProductConcernTags(data.product_id, shopifyProduct, payload)
    savedCount += 1
  }

  return savedCount
}

const renderShopifyAppHome = (res, dashboard) => {
  const {
    shop,
    brand,
    productCount,
    flowCount,
    activeFlow,
    installedAt,
    saved,
    synced,
    syncError
  } = dashboard

  const category = brand?.product_category || 'general'
  const color = brand?.primary_color || '#1B4332'
  const brandName = brand?.name || shopSlug(shop).replace(/-/g, ' ')
  const settingsToken = signShopToken(shop, 'settings')
  const syncToken = signShopToken(shop, 'sync_products')
  const activeFlowLabel = activeFlow ? 'Ready' : 'Needed'

  res
    .type('html')
    .send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>AlphaMark AI Recommendation</title>
    <style>
      * { box-sizing: border-box; }
      :root {
        --brand: ${escapeHtml(color)};
        --ink: #101112;
        --muted: #61666d;
        --line: #e2e5e9;
        --surface: #ffffff;
        --soft: #f6f7f8;
        --accent: #d9ff57;
      }
      body {
        margin: 0;
        padding: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--ink);
        background: #fff;
      }
      main {
        max-width: 1240px;
        margin: 0 auto;
        padding: 28px;
      }
      h1, h2, h3, p { margin-top: 0; }
      h1, h2, h3 {
        letter-spacing: 0;
      }
      h1 {
        margin-bottom: 14px;
        max-width: 760px;
        font-size: clamp(34px, 5vw, 58px);
        line-height: 1.02;
      }
      h2 {
        margin-bottom: 12px;
        font-size: 20px;
      }
      h3 {
        margin-bottom: 8px;
        font-size: 15px;
      }
      p {
        margin-bottom: 12px;
        color: var(--muted);
        line-height: 1.5;
      }
      code {
        display: inline-block;
        max-width: 100%;
        padding: 3px 7px;
        border-radius: 5px;
        background: #f0f1f2;
        word-break: break-word;
      }
      .topbar {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 16px;
        align-items: center;
        padding-bottom: 22px;
        border-bottom: 1px solid var(--line);
      }
      .brand-mark {
        display: inline-grid;
        place-items: center;
        width: 48px;
        height: 48px;
        border-radius: 12px;
        color: #fff;
        background: var(--brand);
        font-weight: 800;
      }
      .top-title {
        display: flex;
        gap: 12px;
        align-items: center;
      }
      .top-title strong {
        display: block;
        font-size: 18px;
      }
      .top-title span {
        color: var(--muted);
        font-size: 13px;
      }
      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(360px, .82fr);
        gap: 28px;
        align-items: stretch;
        padding: 34px 0 24px;
      }
      .hero-copy {
        padding: 28px 0;
      }
      .eyebrow {
        display: inline-flex;
        align-items: center;
        min-height: 28px;
        margin-bottom: 18px;
        padding: 0 11px;
        border: 1px solid var(--line);
        border-radius: 999px;
        color: var(--ink);
        background: var(--surface);
        font-size: 13px;
        font-weight: 700;
      }
      .hero-lede {
        max-width: 660px;
        color: #41464c;
        font-size: 18px;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        margin-top: 22px;
      }
      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 46px;
        padding: 0 20px;
        border: 0;
        border-radius: 999px;
        color: #fff;
        background: #111;
        text-decoration: none;
        font-weight: 750;
        cursor: pointer;
      }
      .button.secondary {
        color: var(--ink);
        background: #fff;
        border: 1px solid #bfc5cc;
      }
      .button.brand {
        background: var(--brand);
      }
      .preview {
        min-height: 390px;
        padding: 22px;
        border-radius: 8px;
        background: #123943;
        color: #fff;
        overflow: hidden;
      }
      .preview-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        height: 100%;
      }
      .preview-card {
        min-height: 112px;
        padding: 16px;
        border-radius: 8px;
        background: #fff;
        color: #182026;
      }
      .preview-card.feature {
        display: grid;
        place-items: center;
        min-height: 150px;
        background: #ff9b84;
        font-size: 34px;
        font-weight: 850;
      }
      .preview-card.dark {
        background: #1a4e58;
        color: #fff;
      }
      .preview-card.accent {
        background: var(--accent);
      }
      .spark {
        height: 48px;
        margin-top: 12px;
        border-radius: 8px;
        background:
          linear-gradient(135deg, transparent 10%, rgba(31,111,80,.18) 11% 18%, transparent 19%),
          linear-gradient(90deg, #eef2ff, #f7e9ff);
      }
      .notice {
        margin-bottom: 16px;
        padding: 12px 14px;
        border: 1px solid #9de4bd;
        border-radius: 8px;
        color: #0a6b45;
        background: #d1f7e5;
        font-weight: 700;
      }
      .notice.error {
        color: #8a6116;
        background: #fff4d6;
        border-color: #ffd98d;
      }
      .layout {
        display: grid;
        grid-template-columns: 300px minmax(0, 1fr);
        gap: 28px;
        align-items: start;
      }
      .sidebar {
        position: sticky;
        top: 18px;
      }
      .side-card, .panel, .metric {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
      }
      .side-card {
        padding: 20px;
      }
      .app-id {
        display: inline-flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 22px;
      }
      .status {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 5px 10px;
        color: #0a6b45;
        background: #d1f7e5;
        font-weight: 750;
        font-size: 13px;
      }
      .side-list {
        display: grid;
        gap: 16px;
        margin-top: 18px;
        padding-top: 18px;
        border-top: 1px solid var(--line);
      }
      .side-list span {
        display: block;
        color: var(--muted);
        font-size: 13px;
        margin-bottom: 4px;
      }
      .content {
        display: grid;
        gap: 18px;
      }
      .metrics {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 14px;
      }
      .metric {
        padding: 20px;
      }
      .metric strong {
        display: block;
        margin-bottom: 6px;
        font-size: 30px;
      }
      .metric span {
        color: var(--muted);
        font-size: 13px;
        font-weight: 650;
      }
      .panel {
        padding: 22px;
      }
      .two-col {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(280px, .82fr);
        gap: 18px;
      }
      .steps {
        display: grid;
        gap: 12px;
      }
      .settings {
        display: grid;
        gap: 14px;
      }
      .field {
        display: grid;
        gap: 7px;
      }
      .field label {
        font-weight: 750;
      }
      .field input[type="text"],
      .field input[type="color"] {
        width: 100%;
        min-height: 42px;
        border: 1px solid #bfc5cc;
        border-radius: 6px;
        padding: 8px 10px;
      }
      .field input[type="color"] {
        padding: 3px;
      }
      .step {
        display: grid;
        grid-template-columns: 22px minmax(0, 1fr);
        gap: 10px;
        align-items: start;
      }
      .dot {
        width: 22px;
        height: 22px;
        border-radius: 999px;
        display: inline-grid;
        place-items: center;
        color: #fff;
        background: var(--brand);
        font-size: 12px;
        font-weight: 700;
      }
      .section-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 14px;
      }
      @media (max-width: 800px) {
        main { padding: 18px; }
        .topbar, .hero, .layout, .metrics, .two-col, .preview-grid { grid-template-columns: 1fr; }
        .hero-copy { padding: 10px 0; }
        .preview { min-height: auto; }
        .sidebar { position: static; }
      }
    </style>
  </head>
  <body>
    <main>
      ${saved ? '<div class="notice">Settings saved.</div>' : ''}
      ${synced ? `<div class="notice">${Number(synced)} Shopify products synced.</div>` : ''}
      ${syncError ? `<div class="notice error">${escapeHtml(syncError)}</div>` : ''}

      <header class="topbar">
        <div class="top-title">
          <div class="brand-mark">AM</div>
          <div>
            <strong>AlphaMark AI Recommendation</strong>
            <span>Personalized product advisor for Shopify brands</span>
          </div>
        </div>
        <span class="status">Connected</span>
      </header>

      <section class="hero">
        <div class="hero-copy">
          <div class="eyebrow">Installed for ${escapeHtml(shop)}</div>
          <h1>Turn shopper answers into AI product recommendations.</h1>
          <p class="hero-lede">Sync Shopify products, generate a brand-specific question flow, and launch a storefront advisor that works for any product category.</p>
          <div class="actions">
            <a class="button brand" href="${escapeHtml(themeEditorUrl(shop))}" target="_top">Open theme editor</a>
            <a class="button secondary" href="${escapeHtml(storefrontUrl(shop))}" target="_blank">View storefront</a>
          </div>
        </div>

        <div class="preview" aria-hidden="true">
          <div class="preview-grid">
            <div class="preview-card">
              <h3>Detailed analytics</h3>
              <strong>${Number(productCount || 0)} products</strong>
              <div class="spark"></div>
            </div>
            <div class="preview-card dark">
              <h3>Brand flow</h3>
              <strong>${escapeHtml(activeFlowLabel)}</strong>
            </div>
            <div class="preview-card feature">AlphaMark</div>
            <div class="preview-card accent">
              <h3>Storefront widget</h3>
              <strong>Find my match</strong>
            </div>
          </div>
        </div>
      </section>

      <section class="layout">
        <aside class="sidebar">
          <div class="side-card">
            <div class="app-id">
              <div class="brand-mark">AM</div>
              <div>
                <h2>${escapeHtml(brandName)}</h2>
                <p style="margin-bottom: 0;">AI Recommendation</p>
              </div>
            </div>
            <span class="status">Live connection</span>
            <div class="side-list">
              <div>
                <span>Shop</span>
                <code>${escapeHtml(shop)}</code>
              </div>
              <div>
                <span>Brand category</span>
                <strong>${escapeHtml(category)}</strong>
              </div>
              <div>
                <span>Brand API key</span>
                <code>${escapeHtml(maskKey(brand?.api_key))}</code>
              </div>
              <div>
                <span>Installed</span>
                <strong>${escapeHtml(installedAt || 'Connected')}</strong>
              </div>
            </div>
          </div>
        </aside>

        <div class="content">
          <div class="metrics">
            <div class="metric">
              <strong>${Number(productCount || 0)}</strong>
              <span>Products synced</span>
            </div>
            <div class="metric">
              <strong>${Number(flowCount || 0)}</strong>
              <span>Question flows</span>
            </div>
            <div class="metric">
              <strong>${escapeHtml(activeFlowLabel)}</strong>
              <span>Recommendation flow</span>
            </div>
          </div>

          <div class="two-col">
            <section class="panel">
              <div class="section-title">
                <h2>Shopify products</h2>
              </div>
              <p>Import this store's Shopify catalog into AlphaMark so the advisor can recommend real products from the brand.</p>
              <form class="settings" method="post" action="/shopify/products/sync">
                <input type="hidden" name="shop" value="${escapeHtml(shop)}">
                <input type="hidden" name="token" value="${escapeHtml(syncToken)}">
                <button class="button brand" type="submit">Sync Shopify products</button>
              </form>
            </section>

            <section class="panel">
              <h2>Brand settings</h2>
              <form class="settings" method="post" action="/shopify/settings">
                <input type="hidden" name="shop" value="${escapeHtml(shop)}">
                <input type="hidden" name="token" value="${escapeHtml(settingsToken)}">
                <div class="field">
                  <label for="category">Brand category</label>
                  <input id="category" name="category" type="text" value="${escapeHtml(category)}" placeholder="fragrance, pet care, fitness">
                </div>
                <div class="field">
                  <label for="primary_color">Widget color</label>
                  <input id="primary_color" name="primary_color" type="color" value="${escapeHtml(color)}">
                </div>
                <button class="button secondary" type="submit">Save settings</button>
              </form>
            </section>
          </div>

          <section class="panel">
            <h2>Launch checklist</h2>
            <div class="steps">
              <div class="step">
                <span class="dot">1</span>
                <p>Sync Shopify products so the recommendation engine has real catalog data.</p>
              </div>
              <div class="step">
                <span class="dot">2</span>
                <p>Generate or verify the question flow for <code>${escapeHtml(category)}</code>.</p>
              </div>
              <div class="step">
                <span class="dot">3</span>
                <p>Enable the AlphaMark app embed in the theme editor and test the storefront button.</p>
              </div>
            </div>
          </section>
        </div>
      </section>
    </main>
  </body>
</html>`)
}

const getInstalledStore = async shop => {
  const { data, error } = await supabase
    .from('shopify_stores')
    .select('shop_domain, brand_id, installed_at')
    .eq('shop_domain', shop)
    .is('uninstalled_at', null)
    .maybeSingle()

  if (error) throw error
  return data
}

const getShopDashboard = async shop => {
  const { data: store, error: storeError } = await supabase
    .from('shopify_stores')
    .select(`
      shop_domain,
      installed_at,
      brands(brand_id, name, slug, api_key, product_category, primary_color)
    `)
    .eq('shop_domain', shop)
    .is('uninstalled_at', null)
    .maybeSingle()

  if (storeError) throw storeError
  if (!store?.brands) return null

  const brandId = store.brands.brand_id

  const [
    { count: productCount, error: productCountError },
    { count: flowCount, error: flowCountError },
    { data: activeFlow, error: activeFlowError }
  ] = await Promise.all([
    supabase
      .from('products')
      .select('product_id', { count: 'exact', head: true })
      .eq('brand_id', brandId),
    supabase
      .from('brand_question_flows')
      .select('flow_id', { count: 'exact', head: true })
      .eq('brand_id', brandId),
    supabase
      .from('brand_question_flows')
      .select('flow_id')
      .eq('brand_id', brandId)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle()
  ])

  if (productCountError) throw productCountError
  if (flowCountError) throw flowCountError
  if (activeFlowError) throw activeFlowError

  return {
    shop,
    brand: store.brands,
    productCount,
    flowCount,
    activeFlow: Boolean(activeFlow),
    installedAt: store.installed_at
      ? new Date(store.installed_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
      : null
  }
}

const createBrandForShop = async shop => {
  const slug = shopSlug(shop)
  const apiKey = `shop_${crypto.randomBytes(18).toString('hex')}`

  const { data: existingBrand, error: existingBrandError } = await supabase
    .from('brands')
    .select('brand_id, api_key, product_category')
    .eq('slug', slug)
    .maybeSingle()

  if (existingBrandError) throw existingBrandError
  if (existingBrand) return existingBrand

  const { data, error } = await supabase
    .from('brands')
    .insert({
      name: slug.replace(/-/g, ' '),
      slug,
      api_key: apiKey,
      product_category: 'general',
      primary_color: '#1B4332',
      is_active: true
    })
    .select('brand_id, api_key, product_category')
    .single()

  if (error?.code === '23505') {
    const { data: brandAfterConflict, error: conflictLookupError } = await supabase
      .from('brands')
      .select('brand_id, api_key, product_category')
      .eq('slug', slug)
      .single()

    if (conflictLookupError) throw conflictLookupError
    return brandAfterConflict
  }

  if (error) throw error
  return data
}

const findOrCreateShopBrand = async shop => {
  const { data: existingStore, error: storeError } = await supabase
    .from('shopify_stores')
    .select('brand_id, brands(brand_id, api_key, product_category)')
    .eq('shop_domain', shop)
    .maybeSingle()

  if (storeError) throw storeError
  if (existingStore?.brands) return existingStore.brands

  return createBrandForShop(shop)
}

const startShopifyInstall = async (req, res) => {
  try {
    const { apiKey, scopes, appUrl } = shopifyConfig()
    const shop = req.query.shop

    if (!apiKey || !process.env.SHOPIFY_API_SECRET || !appUrl) {
      return res.status(500).send('Shopify app environment variables are not configured.')
    }

    if (!isValidShopDomain(shop)) {
      return res.status(400).send('A valid shop query parameter is required.')
    }

    const installedStore = await getInstalledStore(shop)
    if (installedStore) {
      const dashboard = await getShopDashboard(shop)
      return renderShopifyAppHome(res, {
        ...(dashboard || { shop }),
        saved: req.query.saved === '1',
        synced: req.query.synced,
        syncError: req.query.sync_error
      })
    }

    const redirectUri = `${appUrl}/shopify/callback`
    const installUrl = new URL(`https://${shop}/admin/oauth/authorize`)
    installUrl.searchParams.set('client_id', apiKey)
    installUrl.searchParams.set('scope', scopes)
    installUrl.searchParams.set('redirect_uri', redirectUri)
    installUrl.searchParams.set('state', signState(shop))

    res.redirect(installUrl.toString())
  } catch (error) {
    console.error('Shopify install error:', error)
    res.status(500).send(error.message)
  }
}

const syncShopifyProducts = async (req, res) => {
  const { appUrl } = shopifyConfig()
  const shop = req.body.shop

  try {
    const token = req.body.token

    if (!isValidShopDomain(shop)) {
      return res.status(400).send('A valid shop is required.')
    }

    if (!verifyShopToken(token, shop, 'sync_products')) {
      return res.status(401).send('Invalid product sync token.')
    }

    const { data: store, error: storeError } = await supabase
      .from('shopify_stores')
      .select(`
        shop_domain,
        access_token,
        brands(brand_id, product_category)
      `)
      .eq('shop_domain', shop)
      .is('uninstalled_at', null)
      .maybeSingle()

    if (storeError) throw storeError
    if (!store?.access_token || !store?.brands?.brand_id) {
      return res.status(404).send('Shop is not connected to AlphaMark.')
    }

    const shopifyProducts = await fetchShopifyProducts(shop, store.access_token)
    const savedCount = await saveShopifyProducts(shop, store.brands, shopifyProducts)

    res.redirect(`${appUrl}/shopify?shop=${encodeURIComponent(shop)}&synced=${savedCount}`)
  } catch (error) {
    console.error('Shopify product sync error:', error.response?.data || error)
    const message = encodeURIComponent(error.response?.data?.errors || error.message || 'Product sync failed.')
    res.redirect(`${appUrl}/shopify?shop=${encodeURIComponent(shop)}&sync_error=${message}`)
  }
}

const updateShopifySettings = async (req, res) => {
  try {
    const { appUrl } = shopifyConfig()
    const shop = req.body.shop
    const token = req.body.token
    const category = normalizeBrandCategory(req.body.category)
    const primaryColor = req.body.primary_color || '#1B4332'

    if (!isValidShopDomain(shop)) {
      return res.status(400).send('A valid shop is required.')
    }

    if (!verifyShopToken(token, shop, 'settings')) {
      return res.status(401).send('Invalid settings token.')
    }

    if (!category) {
      return res.status(400).send('Brand category is required.')
    }

    if (!isValidHexColor(primaryColor)) {
      return res.status(400).send('Invalid widget color.')
    }

    const dashboard = await getShopDashboard(shop)
    if (!dashboard?.brand?.brand_id) {
      return res.status(404).send('Shop is not connected to AlphaMark.')
    }

    const { error } = await supabase
      .from('brands')
      .update({
        product_category: category,
        primary_color: primaryColor
      })
      .eq('brand_id', dashboard.brand.brand_id)

    if (error) throw error

    res.redirect(`${appUrl}/shopify?shop=${encodeURIComponent(shop)}&saved=1`)
  } catch (error) {
    console.error('Shopify settings update error:', error)
    res.status(500).send(error.message)
  }
}

const handleShopifyCallback = async (req, res) => {
  try {
    const { apiKey, apiSecret, scopes } = shopifyConfig()
    const { shop, code, state } = req.query

    if (!apiKey || !apiSecret) {
      return res.status(500).send('Shopify app environment variables are not configured.')
    }

    if (!isValidShopDomain(shop) || !code) {
      return res.status(400).send('Invalid Shopify callback.')
    }

    if (!verifyState(state, shop) || !verifyShopifyHmac(req.query)) {
      return res.status(400).send('Invalid Shopify callback signature.')
    }

    const tokenResponse = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: apiKey,
      client_secret: apiSecret,
      code
    })

    const accessToken = tokenResponse.data.access_token
    const brand = await findOrCreateShopBrand(shop)

    const { error: upsertError } = await supabase
      .from('shopify_stores')
      .upsert({
        shop_domain: shop,
        access_token: accessToken,
        scopes,
        brand_id: brand.brand_id,
        installed_at: new Date().toISOString(),
        uninstalled_at: null
      }, { onConflict: 'shop_domain' })

    if (upsertError) throw upsertError

    res.redirect(`${shopifyConfig().appUrl}/shopify?shop=${encodeURIComponent(shop)}`)
  } catch (error) {
    console.error('Shopify callback error:', error.response?.data || error)
    res.status(500).send(error.message)
  }
}

const getShopBrandConfig = async (req, res) => {
  try {
    const shop = req.query.shop

    if (!isValidShopDomain(shop)) {
      return res.status(400).json({ success: false, error: 'Valid shop is required.' })
    }

    const { data, error } = await supabase
      .from('shopify_stores')
      .select('shop_domain, brands(api_key, product_category, primary_color)')
      .eq('shop_domain', shop)
      .is('uninstalled_at', null)
      .maybeSingle()

    if (error) throw error
    if (!data?.brands) {
      return res.status(404).json({ success: false, error: 'Shop is not connected to AlphaMark.' })
    }

    res.json({
      success: true,
      shop: data.shop_domain,
      brand_key: data.brands.api_key,
      brand_category: data.brands.product_category || 'general',
      primary_color: data.brands.primary_color || '#1B4332'
    })
  } catch (error) {
    console.error('Shopify brand config error:', error)
    res.status(500).json({ success: false, error: error.message })
  }
}

const verifyShopifyWebhook = req => {
  const { apiSecret } = shopifyConfig()
  const hmac = req.get('x-shopify-hmac-sha256')

  if (!apiSecret || !hmac || !Buffer.isBuffer(req.body)) return false

  const digest = crypto
    .createHmac('sha256', apiSecret)
    .update(req.body)
    .digest('base64')

  const digestBuffer = Buffer.from(digest)
  const hmacBuffer = Buffer.from(hmac)

  return digestBuffer.length === hmacBuffer.length &&
    crypto.timingSafeEqual(digestBuffer, hmacBuffer)
}

const handleAppUninstalledWebhook = async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      return res.status(401).send('Invalid Shopify webhook signature.')
    }

    const payload = JSON.parse(req.body.toString('utf8'))
    const shop = payload.myshopify_domain || payload.domain

    if (!isValidShopDomain(shop)) {
      return res.status(400).send('Invalid shop domain.')
    }

    const { error } = await supabase
      .from('shopify_stores')
      .update({
        access_token: null,
        uninstalled_at: new Date().toISOString()
      })
      .eq('shop_domain', shop)

    if (error) throw error

    res.status(200).send('OK')
  } catch (error) {
    console.error('Shopify uninstall webhook error:', error)
    res.status(500).send(error.message)
  }
}

const handleAppScopesUpdateWebhook = async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      return res.status(401).send('Invalid Shopify webhook signature.')
    }

    res.status(200).send('OK')
  } catch (error) {
    console.error('Shopify scopes update webhook error:', error)
    res.status(500).send(error.message)
  }
}

const shopifyHealth = (req, res) => {
  res.send('AlphaMark Shopify app is running.')
}

module.exports = {
  startShopifyInstall,
  updateShopifySettings,
  syncShopifyProducts,
  handleShopifyCallback,
  getShopBrandConfig,
  handleAppUninstalledWebhook,
  handleAppScopesUpdateWebhook,
  shopifyHealth
}
