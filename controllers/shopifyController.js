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

const renderShopifyAppHome = (res, dashboard) => {
  const {
    shop,
    brand,
    productCount,
    flowCount,
    activeFlow,
    installedAt,
    saved
  } = dashboard

  const category = brand?.product_category || 'general'
  const color = brand?.primary_color || '#1B4332'
  const brandName = brand?.name || shopSlug(shop).replace(/-/g, ' ')
  const settingsToken = signShopToken(shop, 'settings')

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
      body {
        margin: 0;
        padding: 28px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #202223;
        background: #f6f6f7;
      }
      main { max-width: 1120px; }
      .eyebrow {
        color: #5c5f62;
        font-size: 13px;
        margin-bottom: 8px;
      }
      h1 {
        margin: 0 0 20px;
        font-size: 28px;
        letter-spacing: 0;
      }
      h2 {
        margin: 0 0 12px;
        font-size: 16px;
        letter-spacing: 0;
      }
      p { margin: 8px 0; line-height: 1.5; color: #4d5358; }
      .grid {
        display: grid;
        grid-template-columns: minmax(0, 1.35fr) minmax(280px, .65fr);
        gap: 16px;
      }
      .panel, .metric {
        background: #fff;
        border: 1px solid #dfe3e8;
        border-radius: 8px;
        padding: 20px;
      }
      .metrics {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        margin: 16px 0;
      }
      .metric strong {
        display: block;
        font-size: 24px;
        margin-bottom: 4px;
      }
      .metric span { color: #6d7175; font-size: 13px; }
      .status {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border-radius: 999px;
        padding: 5px 10px;
        color: #0a6b45;
        background: #d1f7e5;
        font-weight: 650;
        font-size: 13px;
      }
      .notice {
        margin-bottom: 16px;
        padding: 12px 14px;
        border-radius: 8px;
        color: #0a6b45;
        background: #d1f7e5;
        border: 1px solid #9de4bd;
        font-weight: 650;
      }
      .rows { margin-top: 16px; border-top: 1px solid #ebedf0; }
      .row {
        display: grid;
        grid-template-columns: 170px minmax(0, 1fr);
        gap: 16px;
        padding: 12px 0;
        border-bottom: 1px solid #ebedf0;
      }
      .label { color: #6d7175; }
      code {
        background: #f1f2f4;
        border-radius: 4px;
        padding: 2px 6px;
        word-break: break-word;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 16px;
      }
      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 38px;
        padding: 0 14px;
        border-radius: 6px;
        color: #fff;
        background: #1f6f50;
        text-decoration: none;
        font-weight: 650;
      }
      .button.secondary {
        color: #202223;
        background: #fff;
        border: 1px solid #babfc3;
      }
      .steps {
        display: grid;
        gap: 10px;
        margin-top: 12px;
      }
      .settings {
        display: grid;
        gap: 14px;
        margin-top: 16px;
      }
      .field {
        display: grid;
        gap: 6px;
      }
      .field label {
        font-weight: 650;
      }
      .field select,
      .field input[type="text"],
      .field input[type="color"] {
        width: 100%;
        min-height: 38px;
        border: 1px solid #babfc3;
        border-radius: 6px;
        padding: 7px 10px;
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
        background: ${escapeHtml(color)};
        font-size: 12px;
        font-weight: 700;
      }
      @media (max-width: 800px) {
        body { padding: 18px; }
        .grid, .metrics { grid-template-columns: 1fr; }
        .row { grid-template-columns: 1fr; gap: 4px; }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">Shopify app</div>
      <h1>AlphaMark AI Recommendation</h1>
      ${saved ? '<div class="notice">Settings saved.</div>' : ''}

      <section class="grid">
        <div class="panel">
          <span class="status">Connected</span>
          <h2 style="margin-top: 16px;">${escapeHtml(brandName)}</h2>
          <p>Your storefront widget can resolve this Shopify store to its AlphaMark brand configuration.</p>

          <div class="metrics">
            <div class="metric">
              <strong>${Number(productCount || 0)}</strong>
              <span>Products synced in AlphaMark</span>
            </div>
            <div class="metric">
              <strong>${Number(flowCount || 0)}</strong>
              <span>Question flows</span>
            </div>
            <div class="metric">
              <strong>${activeFlow ? 'Yes' : 'No'}</strong>
              <span>Active flow</span>
            </div>
          </div>

          <div class="rows">
            <div class="row">
              <div class="label">Shop</div>
              <div><code>${escapeHtml(shop)}</code></div>
            </div>
            <div class="row">
              <div class="label">Brand category</div>
              <div>${escapeHtml(category)}</div>
            </div>
            <div class="row">
              <div class="label">Brand API key</div>
              <div><code>${escapeHtml(maskKey(brand?.api_key))}</code></div>
            </div>
            <div class="row">
              <div class="label">Installed</div>
              <div>${escapeHtml(installedAt || 'Connected')}</div>
            </div>
          </div>

          <div class="actions">
            <a class="button" href="${escapeHtml(themeEditorUrl(shop))}" target="_top">Open theme editor</a>
            <a class="button secondary" href="${escapeHtml(storefrontUrl(shop))}" target="_blank">View storefront</a>
          </div>
        </div>

        <aside class="panel">
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
            <button class="button" type="submit">Save settings</button>
          </form>
        </aside>

        <aside class="panel">
          <h2>Setup checklist</h2>
          <div class="steps">
            <div class="step">
              <span class="dot">1</span>
              <p>Keep the AlphaMark app embed enabled in the theme editor.</p>
            </div>
            <div class="step">
              <span class="dot">2</span>
              <p>Generate or verify the question flow for <code>${escapeHtml(category)}</code>.</p>
            </div>
            <div class="step">
              <span class="dot">3</span>
              <p>Test the floating storefront button and complete one recommendation flow.</p>
            </div>
          </div>
        </aside>
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
      return renderShopifyAppHome(res, { ...(dashboard || { shop }), saved: req.query.saved === '1' })
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
  handleShopifyCallback,
  getShopBrandConfig,
  handleAppUninstalledWebhook,
  handleAppScopesUpdateWebhook,
  shopifyHealth
}
