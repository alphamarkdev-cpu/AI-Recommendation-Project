const crypto = require('crypto')
const axios = require('axios')
const supabase = require('../config/supabase')
const { generateQuestionFlowForBrand } = require('./questionsController')

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

const getErrorMessage = (error, fallback = 'Internal server error') => {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error
  if (error?.message) return String(error.message)
  if (error?.error_description) return String(error.error_description)
  if (error?.error) return String(error.error)
  try {
    const serialized = JSON.stringify(error)
    return serialized && serialized !== '{}' ? serialized : fallback
  } catch {
    return fallback
  }
}

const isMissingColumnError = (error, table, column) => {
  const message = getErrorMessage(error, '')
  return (
    message.includes(`'${column}'`) &&
    message.includes(`'${table}'`) &&
    message.includes('schema cache')
  ) || (
    message.includes(`${table}.${column}`) &&
    message.includes('does not exist')
  )
}

const isMissingStoreColumnError = (error, column) => (
  isMissingColumnError(error, 'shopify_stores', column)
)

const isMissingStoreSettingsColumnError = error => (
  isMissingStoreColumnError(error, 'primary_color') ||
  isMissingStoreColumnError(error, 'product_category')
)

const upsertShopifyStore = async payload => {
  const { error } = await supabase
    .from('shopify_stores')
    .upsert(payload, { onConflict: 'shop_domain' })

  if (!isMissingStoreSettingsColumnError(error)) {
    if (error) throw error
    return
  }

  const { primary_color, product_category, ...fallbackPayload } = payload
  const { error: fallbackError } = await supabase
    .from('shopify_stores')
    .upsert(fallbackPayload, { onConflict: 'shop_domain' })

  if (fallbackError) throw fallbackError
}

const definedPayload = payload => Object.fromEntries(
  Object.entries(payload).filter(([, value]) => value !== undefined && value !== null)
)

const updateShopifyStoreSettings = async (storeId, settings) => {
  let payload = definedPayload(settings)
  if (!storeId || !Object.keys(payload).length) return

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { error } = await supabase
      .from('shopify_stores')
      .update(payload)
      .eq('id', storeId)

    if (!error) return

    if (isMissingStoreColumnError(error, 'product_category')) {
      const { product_category, ...fallbackPayload } = payload
      payload = fallbackPayload
      if (!Object.keys(payload).length) return
      continue
    }

    if (isMissingStoreColumnError(error, 'primary_color')) {
      const { primary_color, ...fallbackPayload } = payload
      payload = fallbackPayload
      if (!Object.keys(payload).length) return
      continue
    }

    throw error
  }
}

const syncBrandAndStoreSettings = async ({ brandId, storeId, productCategory, primaryColor }) => {
  const settings = definedPayload({
    product_category: productCategory,
    primary_color: primaryColor
  })
  if (!Object.keys(settings).length) return

  if (brandId) {
    const { error } = await supabase
      .from('brands')
      .update(settings)
      .eq('brand_id', brandId)

    if (error) throw error
  }

  await updateShopifyStoreSettings(storeId, settings)
}

// --- Shopify token helpers (expiring offline tokens with refresh) ---
const getShopRecord = async (shop) => {
  const { data, error } = await supabase
    .from('shopify_stores')
    .select('*')
    .eq('shop_domain', shop)
    .maybeSingle()
  if (error) throw error
  return data
}

const tokenExpiryFields = (tokenData) => {
  const expiresAt = tokenData.expires_in
    ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    : null
  const refreshTokenExpiresAt = tokenData.refresh_token_expires_in
    ? new Date(Date.now() + tokenData.refresh_token_expires_in * 1000).toISOString()
    : null

  return { expiresAt, refreshTokenExpiresAt }
}

const persistShopifyToken = async (shop, tokenData) => {
  if (!tokenData?.access_token) {
    throw new Error('Shopify did not return an access token.')
  }

  const { expiresAt, refreshTokenExpiresAt } = tokenExpiryFields(tokenData)
  const updates = {
    access_token: tokenData.access_token
  }

  if (tokenData.refresh_token) updates.refresh_token = tokenData.refresh_token
  if (expiresAt) updates.expires_at = expiresAt
  if (refreshTokenExpiresAt) updates.refresh_token_expires_at = refreshTokenExpiresAt

  const { error } = await supabase
    .from('shopify_stores')
    .update(updates)
    .eq('shop_domain', shop)

  if (error) throw error

  return tokenData.access_token
}

const migrateOfflineTokenToExpiring = async (shop, accessToken) => {
  const { apiKey, apiSecret } = shopifyConfig()
  if (!accessToken) return null

  const payload = new URLSearchParams({
    client_id: apiKey,
    client_secret: apiSecret,
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: accessToken,
    subject_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
    requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
    expiring: '1'
  })

  const response = await axios.post(`https://${shop}/admin/oauth/access_token`, payload, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  })

  return persistShopifyToken(shop, response.data || {})
}

const refreshAccessToken = async (shop, refreshToken) => {
  try {
    const { apiKey, apiSecret } = shopifyConfig()
    if (!refreshToken) throw new Error('No refresh token available')

    const payload = new URLSearchParams({
      client_id: apiKey,
      client_secret: apiSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })

    const resp = await axios.post(`https://${shop}/admin/oauth/access_token`, payload, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    })

    return persistShopifyToken(shop, resp.data || {})
  } catch (err) {
    console.error('Error refreshing Shopify token for', shop, err.response?.data || getErrorMessage(err) || err)
    throw err
  }
}

const getValidAccessToken = async (shop) => {
  const store = await getShopRecord(shop)
  if (!store) return null
  // if expires_at is provided and token not expired, return access_token
  if (store.expires_at) {
    const exp = new Date(store.expires_at).getTime()
    // refresh if token expires within next 60 seconds
    if (Date.now() < exp - 60000) {
      return store.access_token
    }
    // otherwise try refreshing
    if (store.refresh_token) {
      return await refreshAccessToken(shop, store.refresh_token)
    }
    return migrateOfflineTokenToExpiring(shop, store.access_token)
  }
  return migrateOfflineTokenToExpiring(shop, store.access_token)
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

const isDefaultCategory = value => normalizeBrandCategory(value) === 'general'

const ACCESSORY_CATEGORY_TERMS = [
  'accessor',
  'bag',
  'duffel',
  'handbag',
  'hat',
  'jewel',
  'necklace',
  'scarf',
  'shawl',
  'sunglass',
  'wallet',
  'watch'
]

const isAccessoryCategory = category => {
  const normalized = normalizeBrandCategory(category)
  return ACCESSORY_CATEGORY_TERMS.some(term => normalized.includes(term))
}

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

const GENERIC_SHOPIFY_TAG_PATTERNS = [
  /^all$/i,
  /^shop all$/i,
  /^all collection$/i,
  /^hidden[_\s-]*product$/i,
  /^general$/i,
  /collection/i,
  /^new$/i,
  /^best sellers?$/i,
  /^featured$/i,
  /^homepage$/i,
  /^sale$/i
]

const isUsefulShopifyTag = tag => {
  const value = String(tag || '').replace(/[_-]+/g, ' ').trim()
  return value.length >= 3 && !GENERIC_SHOPIFY_TAG_PATTERNS.some(pattern => pattern.test(value))
}

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
  let cursor = null

  const query = `
    query AlphaMarkProducts($cursor: String) {
      products(first: 250, after: $cursor) {
        edges {
          cursor
          node {
            id
            legacyResourceId
            title
            handle
            vendor
            productType
            tags
            status
            descriptionHtml
            category {
              id
              name
              fullName
            }
            featuredImage {
              url
            }
            images(first: 1) {
              edges {
                node {
                  url
                }
              }
            }
            variants(first: 1) {
              edges {
                node {
                  price
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `

  do {
    const response = await axios.post(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      query,
      variables: { cursor }
    }, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      }
    })

    if (response.data?.errors?.length) {
      throw new Error(response.data.errors.map(error => error.message).join(', '))
    }

    const productConnection = response.data?.data?.products
    products.push(...(productConnection?.edges || []).map(edge => edge.node))
    cursor = productConnection?.pageInfo?.hasNextPage
      ? productConnection.pageInfo.endCursor
      : null
  } while (cursor)

  return products
}

const shopifyProductUrl = (shop, product) => (
  product.handle ? `https://${shop}/products/${product.handle}` : null
)

const firstGraphqlNode = connection => connection?.edges?.[0]?.node

const getProductCategory = (product, brand) => {
  const rawCategory =
    product.category?.name ||
    product.category?.fullName ||
    product.category ||
    product.product_category ||
    product.productType ||
    product.product_type ||
    brand.product_category ||
    'general'

  return normalizeBrandCategory(rawCategory)
}

const buildProductPayload = (shop, brand, product, storeId = null) => {
  const tags = Array.isArray(product.tags)
    ? product.tags.filter(isUsefulShopifyTag)
    : parseShopifyTags(product.tags).filter(isUsefulShopifyTag)
  const firstVariant = product.variants?.[0] || firstGraphqlNode(product.variants)
  const price = Number(firstVariant?.price || 0)
  const graphqlImage = product.featuredImage?.url || firstGraphqlNode(product.images)?.url
  const imageUrl = product.image?.src || product.images?.[0]?.src || graphqlImage || null
  const category = getProductCategory(product, brand)

  return {
    brand_id: brand.brand_id,
    store_id: storeId,
    name: product.title || 'Untitled product',
    category,
    description: stripHtml(product.body_html || product.descriptionHtml),
    recommendation_step: 1,
    recommended_timing: 'As needed',
    how_to_use: 'Apply as part of the recommended routine. Explain the amount, timing, frequency, and order based on this product category.',
    price: Number.isFinite(price) ? price : 0,
    image_url: imageUrl,
    product_url: shopifyProductUrl(shop, product),
    suitable_customer_attributes: tags,
    external_product_id: product.legacyResourceId ? String(product.legacyResourceId) : (product.id ? String(product.id) : null),
    vendor: product.vendor || null,
    product_tags: tags,
    is_active: String(product.status || '').toLowerCase() !== 'archived'
  }
}

const getExistingProductId = async (brandId, payload, storeId = null) => {
  let query = supabase
    .from('products')
    .select('product_id')
    .eq('brand_id', brandId)
    .limit(1)

  if (storeId) query = query.eq('store_id', storeId)

  query = payload.product_url
    ? query.eq('product_url', payload.product_url)
    : query.eq('name', payload.name)

  const { data, error } = await query.maybeSingle()
  if (error) throw error

  return data?.product_id || null
}

const ensureProductMatchTags = async (productId, product, payload) => {
  const { count, error: countError } = await supabase
    .from('product_match_tags')
    .select('product_id', { count: 'exact', head: true })
    .eq('product_id', productId)

  if (countError) throw countError
  if (count) return

  const tags = Array.isArray(product.tags)
    ? product.tags.filter(isUsefulShopifyTag)
    : parseShopifyTags(product.tags).filter(isUsefulShopifyTag)
  const concerns = [
    ...tags,
    product.productType,
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
    .from('product_match_tags')
    .insert(concerns.map((matchTag, index) => ({
      product_id: productId,
      match_tag: matchTag,
      intensity_level: 3,
      priority_score: Math.max(1, 8 - index)
    })))

  if (error) throw error
}

const saveShopifyProducts = async (shop, brand, shopifyProducts, storeId = null) => {
  let savedCount = 0

  for (const shopifyProduct of shopifyProducts) {
    const payload = buildProductPayload(shop, brand, shopifyProduct, storeId)
    const existingProductId = await getExistingProductId(brand.brand_id, payload, storeId)

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

    await ensureProductMatchTags(data.product_id, shopifyProduct, payload)
    savedCount += 1
  }

  return savedCount
}

const inferSyncedProductCategory = (brand, shopifyProducts) => {
  const categoryCounts = new Map()
  let totalCategorizedProducts = 0

  for (const product of shopifyProducts) {
    const category = getProductCategory(product, { ...brand, product_category: null })
    if (!category || isDefaultCategory(category)) continue
    totalCategorizedProducts += 1
    categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1)
  }

  const sortedCategories = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
  const uniqueCategories = sortedCategories.length
  const accessoryProductCount = sortedCategories
    .filter(([category]) => isAccessoryCategory(category))
    .reduce((total, [, count]) => total + count, 0)

  if (
    uniqueCategories >= 3 &&
    accessoryProductCount / totalCategorizedProducts >= 0.6
  ) {
    return 'accessories'
  }

  return sortedCategories.map(([category]) => category)[0] || null
}

const syncStoreCategoryFromProducts = async (store, shopifyProducts) => {
  const inferredCategory = inferSyncedProductCategory(store.brands, shopifyProducts)
  if (!inferredCategory) return store.product_category || store.brands.product_category || 'general'

  const currentCategory = normalizeBrandCategory(store.product_category || store.brands.product_category)
  const shouldUpdateCategory =
    isDefaultCategory(currentCategory) ||
    (
      inferredCategory === 'accessories' &&
      isAccessoryCategory(currentCategory) &&
      currentCategory !== inferredCategory
    )

  if (!shouldUpdateCategory) return store.product_category || store.brands.product_category

  await syncBrandAndStoreSettings({
    brandId: store.brands.brand_id,
    storeId: store.id,
    productCategory: inferredCategory
  })

  store.product_category = inferredCategory
  store.brands.product_category = inferredCategory
  return inferredCategory
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
    questionWarning,
    syncError
  } = dashboard

  const category = dashboard.productCategory || brand?.product_category || 'general'
  const color = dashboard.primaryColor || brand?.primary_color || '#1B4332'
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
        --deep: #103f46;
        --deep-2: #1f6269;
        --success: #ccf6df;
        --warning: #fff4d6;
      }
      body {
        margin: 0;
        padding: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--ink);
        background: #f4f6f3;
      }
      main {
        max-width: 1180px;
        margin: 0 auto;
        padding: 24px;
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
        transition: transform .18s ease, box-shadow .18s ease, background .18s ease;
      }
      .button:hover {
        transform: translateY(-1px);
        box-shadow: 0 12px 24px rgba(16, 17, 18, .12);
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
      .store-header {
        display: grid;
        grid-template-columns: auto minmax(260px, 1fr) auto;
        gap: 24px;
        align-items: center;
        padding: 18px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: rgba(255,255,255,.88);
        box-shadow: 0 14px 40px rgba(18, 57, 67, .08);
      }
      .store-brand {
        display: inline-flex;
        align-items: center;
        gap: 12px;
        font-weight: 850;
        font-size: 18px;
      }
      .search-box {
        min-height: 50px;
        display: flex;
        align-items: center;
        padding: 0 18px;
        border: 1px solid #d2d6dc;
        border-radius: 999px;
        color: #747980;
        background: #fff;
      }
      .setup-strip {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
        margin-top: 14px;
      }
      .setup-stat {
        min-height: 86px;
        padding: 16px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #fff;
      }
      .setup-stat span {
        display: block;
        margin-bottom: 7px;
        color: var(--muted);
        font-size: 12px;
        font-weight: 750;
        text-transform: uppercase;
      }
      .setup-stat strong {
        display: block;
        color: var(--ink);
        font-size: 22px;
        line-height: 1.1;
      }
      .setup-stat.ready strong {
        color: #08724d;
      }
      .listing {
        display: grid;
        grid-template-columns: 290px minmax(0, 1fr);
        gap: 28px;
        padding-top: 24px;
      }
      .listing-sidebar {
        position: sticky;
        top: 18px;
        align-self: start;
      }
      .app-card {
        padding: 20px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #fff;
        box-shadow: 0 14px 40px rgba(18, 57, 67, .07);
      }
      .app-head {
        display: grid;
        grid-template-columns: 54px minmax(0, 1fr);
        gap: 14px;
        align-items: center;
        padding-bottom: 18px;
        border-bottom: 1px solid var(--line);
      }
      .app-logo-lg {
        display: grid;
        place-items: center;
        width: 54px;
        height: 54px;
        border-radius: 8px;
        color: #fff;
        background: var(--deep);
        font-weight: 900;
        font-size: 19px;
      }
      .app-head h1 {
        margin: 0;
        font-size: 22px;
        line-height: 1.18;
      }
      .info-block {
        padding: 18px 0;
        border-bottom: 1px solid var(--line);
      }
      .info-block:last-child {
        border-bottom: 0;
      }
      .info-block span {
        display: block;
        margin-bottom: 8px;
        color: var(--ink);
        font-weight: 800;
      }
      .install-button {
        width: 100%;
        min-height: 52px;
        margin: 8px 0 18px;
        border-radius: 999px;
        background: #111;
        font-size: 15px;
      }
      .demo-link {
        display: block;
        color: #111;
        text-align: center;
        font-weight: 800;
      }
      .media-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 230px;
        gap: 14px;
      }
      .media-main {
        min-height: 420px;
        padding: 22px;
        border-radius: 8px;
        background:
          linear-gradient(135deg, rgba(217,255,87,.18), transparent 28%),
          linear-gradient(160deg, var(--deep), #0f3037 78%);
        box-shadow: inset 0 1px 0 rgba(255,255,255,.12);
      }
      .media-collage {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        height: 100%;
      }
      .shot {
        min-height: 118px;
        padding: 16px;
        border-radius: 8px;
        background: #fff;
        color: #162329;
        box-shadow: 0 10px 26px rgba(0,0,0,.12);
      }
      .shot strong {
        display: block;
        font-size: 20px;
        line-height: 1.15;
      }
      .shot.wide {
        grid-column: span 2;
      }
      .shot.tall {
        grid-row: span 2;
      }
      .shot.brand-shot {
        display: grid;
        place-items: center;
        background: #ff9b84;
        color: var(--deep);
        font-size: 22px;
        font-weight: 900;
        text-align: center;
      }
      .shot.dark-shot {
        background: var(--deep-2);
        color: #fff;
      }
      .shot.accent-shot {
        background: var(--accent);
      }
      .thumbs {
        display: grid;
        gap: 14px;
      }
      .thumb {
        min-height: 130px;
        padding: 14px;
        border-radius: 8px;
        background: var(--deep);
        color: #fff;
      }
      .thumb.muted {
        background: #e9ecef;
        color: #596068;
      }
      .listing-title {
        max-width: 940px;
        margin: 24px 0 10px;
        font-size: 24px;
        line-height: 1.18;
      }
      .listing-copy {
        max-width: 940px;
        color: #4b5056;
        font-size: 15px;
      }
      .feature-list {
        display: grid;
        gap: 8px;
        max-width: 900px;
        margin: 18px 0 0;
        padding-left: 22px;
        color: #353a40;
        font-size: 14px;
        line-height: 1.45;
      }
      .admin-tools {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 14px;
        margin-top: 24px;
      }
      .panel {
        min-height: 232px;
        box-shadow: 0 12px 32px rgba(18, 57, 67, .06);
      }
      .panel h2 {
        font-size: 18px;
      }
      .panel p {
        font-size: 14px;
      }
      @media (max-width: 800px) {
        main { padding: 18px; }
        .topbar, .hero, .layout, .metrics, .two-col, .preview-grid, .store-header, .setup-strip, .listing, .media-grid, .media-collage, .admin-tools { grid-template-columns: 1fr; }
        .hero-copy { padding: 10px 0; }
        .preview { min-height: auto; }
        .sidebar, .listing-sidebar { position: static; }
        .media-main { min-height: auto; }
      }
    </style>
  </head>
  <body>
    <main>
      ${saved ? '<div class="notice">Settings saved.</div>' : ''}
      ${synced ? `<div class="notice">${Number(synced)} Shopify products synced and question flow prepared.</div>` : ''}
      ${questionWarning ? `<div class="notice error">${escapeHtml(questionWarning)}</div>` : ''}
      ${syncError ? `<div class="notice error">${escapeHtml(syncError)}</div>` : ''}

      <header class="store-header">
        <div class="store-brand">
          <div class="app-logo-lg">AM</div>
          <span>AlphaMark AI Console</span>
        </div>
        <div class="search-box">Catalog synced, quiz generated, storefront advisor ready</div>
        <span class="status">Connected</span>
      </header>

      <section class="setup-strip">
        <div class="setup-stat">
          <span>Store</span>
          <strong>${escapeHtml(shopSlug(shop))}</strong>
        </div>
        <div class="setup-stat">
          <span>Catalog</span>
          <strong>${Number(productCount || 0)} products</strong>
        </div>
        <div class="setup-stat">
          <span>Question flows</span>
          <strong>${Number(flowCount || 0)} active</strong>
        </div>
        <div class="setup-stat ready">
          <span>Widget status</span>
          <strong>${escapeHtml(activeFlowLabel)}</strong>
        </div>
      </section>

      <section class="listing">
        <aside class="listing-sidebar">
          <div class="app-card">
            <div class="app-head">
              <div class="app-logo-lg">AM</div>
              <h1>AlphaMark AI Recommendations</h1>
            </div>

            <div class="info-block">
              <span>Pricing</span>
              <p>Free to install for connected Shopify brands.</p>
            </div>

            <div class="info-block">
              <span>Status</span>
              <p><strong>Connected</strong> to <code>${escapeHtml(shop)}</code></p>
            </div>

            <div class="info-block">
              <span>Brand</span>
              <p>${escapeHtml(brandName)}</p>
              <p><code>${escapeHtml(category)}</code></p>
            </div>

            <div class="info-block">
              <a class="button install-button" href="${escapeHtml(themeEditorUrl(shop))}" target="_top">Open theme editor</a>
              <a class="demo-link" href="${escapeHtml(storefrontUrl(shop))}" target="_blank">View storefront</a>
            </div>

            <div class="info-block">
              <span>Store tenant</span>
              <code>${escapeHtml(shop)}</code>
            </div>
          </div>
        </aside>

        <div class="listing-main">
          <div class="media-grid">
            <div class="media-main">
              <div class="media-collage">
                <div class="shot wide">
                  <h3>Detailed analytics</h3>
                  <strong>${Number(productCount || 0)} synced products</strong>
                  <div class="spark"></div>
                </div>
                <div class="shot dark-shot tall">
                  <h3>AI advisor</h3>
                  <p style="color: inherit;">Personalized quiz, catalog matching, and optional photo context.</p>
                </div>
                <div class="shot brand-shot">Live match</div>
                <div class="shot">
                  <h3>Product matching</h3>
                  <strong>${Number(flowCount || 0)} flows</strong>
                </div>
                <div class="shot accent-shot">
                  <h3>Theme widget</h3>
                  <strong>${escapeHtml(activeFlowLabel)}</strong>
                </div>
              </div>
            </div>

            <div class="thumbs">
              <div class="thumb">
                <h3>Storefront advisor</h3>
                <p style="color: inherit;">Floating entry point for shoppers.</p>
              </div>
              <div class="thumb">
                <h3>Admin setup</h3>
                <p style="color: inherit;">Sync catalog and customize brand settings.</p>
              </div>
              <div class="thumb muted">
                <h3>+ more</h3>
                <p style="color: inherit;">Question flows, product matching, AI analysis.</p>
              </div>
            </div>
          </div>

          <h2 class="listing-title">Your AI product advisor is connected to this store.</h2>
          <p class="listing-copy">AlphaMark uses this Shopify catalog, brand category, generated question flow, and optional shopper photo context to recommend relevant products from the store.</p>

          <ul class="feature-list">
            <li>Sync products from Shopify and use real catalog data in the recommendation engine.</li>
            <li>Create flexible question flows for any brand category, not just skincare.</li>
            <li>Launch a storefront widget through the Shopify theme editor.</li>
            <li>Use AI analysis to combine text answers, optional photo signals, and product tags.</li>
            <li>Keep setup simple for brands with an embedded Shopify admin dashboard.</li>
          </ul>

          <div class="admin-tools">
            <section class="panel">
              <h2>Shopify products</h2>
              <p>Refresh the catalog and rebuild the question flow from current SKUs.</p>
              <form class="settings" method="post" action="/shopify/products/sync">
                <input type="hidden" name="shop" value="${escapeHtml(shop)}">
                <input type="hidden" name="token" value="${escapeHtml(syncToken)}">
                <button class="button brand" type="submit">Sync catalog</button>
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

            <section class="panel">
              <h2>Launch checklist</h2>
              <div class="steps">
                <div class="step">
                  <span class="dot">1</span>
                  <p>Sync Shopify products and generate the shopper quiz.</p>
                </div>
                <div class="step">
                  <span class="dot">2</span>
                  <p>Check the <code>${escapeHtml(category)}</code> flow in Supabase if needed.</p>
                </div>
                <div class="step">
                  <span class="dot">3</span>
                  <p>Enable the theme app embed.</p>
                </div>
              </div>
            </section>
          </div>
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

const countProductsForDashboard = async (brandId, storeId) => {
  const scoped = await supabase
    .from('products')
    .select('product_id', { count: 'exact', head: true })
    .eq('brand_id', brandId)
    .eq('store_id', storeId)

  if (!isMissingColumnError(scoped.error, 'products', 'store_id')) {
    if (scoped.error) throw scoped.error
    return scoped.count || 0
  }

  const fallback = await supabase
    .from('products')
    .select('product_id', { count: 'exact', head: true })
    .eq('brand_id', brandId)

  if (fallback.error) throw fallback.error
  return fallback.count || 0
}

const getQuestionFlowDashboardStats = async (brandId, storeId, productCategory) => {
  const [scopedCount, scopedActive] = await Promise.all([
    supabase
      .from('brand_question_flows')
      .select('flow_id', { count: 'exact', head: true })
      .eq('brand_id', brandId)
      .eq('store_id', storeId),
    supabase
      .from('brand_question_flows')
      .select('flow_id')
      .eq('brand_id', brandId)
      .eq('store_id', storeId)
      .eq('category', productCategory)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle()
  ])

  const missingStoreId =
    isMissingColumnError(scopedCount.error, 'brand_question_flows', 'store_id') ||
    isMissingColumnError(scopedActive.error, 'brand_question_flows', 'store_id')

  if (!missingStoreId) {
    if (scopedCount.error) throw scopedCount.error
    if (scopedActive.error) throw scopedActive.error
    return {
      flowCount: scopedCount.count || 0,
      activeFlow: Boolean(scopedActive.data)
    }
  }

  const [fallbackCount, fallbackActive] = await Promise.all([
    supabase
      .from('brand_question_flows')
      .select('flow_id', { count: 'exact', head: true })
      .eq('brand_id', brandId),
    supabase
      .from('brand_question_flows')
      .select('flow_id')
      .eq('brand_id', brandId)
      .eq('category', productCategory)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle()
  ])

  if (fallbackCount.error) throw fallbackCount.error
  if (fallbackActive.error) throw fallbackActive.error

  return {
    flowCount: fallbackCount.count || 0,
    activeFlow: Boolean(fallbackActive.data)
  }
}

const getShopDashboard = async shop => {
  let { data: store, error: storeError } = await supabase
    .from('shopify_stores')
    .select(`
      id,
      shop_domain,
      product_category,
      primary_color,
      installed_at,
      brands(brand_id, name, slug, api_key, product_category, primary_color)
    `)
    .eq('shop_domain', shop)
    .is('uninstalled_at', null)
    .maybeSingle()

  if (isMissingStoreSettingsColumnError(storeError)) {
    const fallback = await supabase
      .from('shopify_stores')
      .select(`
        id,
        shop_domain,
        installed_at,
        brands(brand_id, name, slug, api_key, product_category, primary_color)
      `)
      .eq('shop_domain', shop)
      .is('uninstalled_at', null)
      .maybeSingle()

    store = fallback.data ? { ...fallback.data, product_category: null, primary_color: null } : fallback.data
    storeError = fallback.error
  }

  if (storeError) throw storeError
  if (!store?.brands) return null

  const brandId = store.brands.brand_id
  const storeId = store.id
  const productCategory = store.product_category || store.brands.product_category || 'general'

  const [productCount, questionStats] = await Promise.all([
    countProductsForDashboard(brandId, storeId),
    getQuestionFlowDashboardStats(brandId, storeId, productCategory)
  ])

  return {
    shop,
    brand: store.brands,
    storeId,
    productCategory,
    primaryColor: store.primary_color || store.brands.primary_color || '#1B4332',
    productCount,
    flowCount: questionStats.flowCount,
    activeFlow: questionStats.activeFlow,
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
    .select('brand_id, api_key, product_category, primary_color')
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
    .select('brand_id, api_key, product_category, primary_color')
    .single()

  if (error?.code === '23505') {
    const { data: brandAfterConflict, error: conflictLookupError } = await supabase
      .from('brands')
      .select('brand_id, api_key, product_category, primary_color')
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
    .select('brand_id, brands(brand_id, api_key, product_category, primary_color)')
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
        questionWarning: req.query.question_warning,
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
    res.status(500).send(getErrorMessage(error, 'Shopify app failed to load.'))
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

    let { data: store, error: storeError } = await supabase
      .from('shopify_stores')
      .select(`
        id,
        shop_domain,
        product_category,
        primary_color,
        access_token,
        brands(brand_id, name, product_category, primary_color)
      `)
      .eq('shop_domain', shop)
      .is('uninstalled_at', null)
      .maybeSingle()

    if (isMissingStoreSettingsColumnError(storeError)) {
      const fallback = await supabase
        .from('shopify_stores')
        .select(`
          id,
          shop_domain,
          access_token,
          brands(brand_id, name, product_category, primary_color)
        `)
        .eq('shop_domain', shop)
        .is('uninstalled_at', null)
        .maybeSingle()

      store = fallback.data ? { ...fallback.data, product_category: null, primary_color: null } : fallback.data
      storeError = fallback.error
    }

    if (storeError) throw storeError
    if (!store?.brands?.brand_id) {
      return res.status(404).send('Shop is not connected to AlphaMark.')
    }

    // Obtain a valid (refreshed if needed) access token
    const liveToken = await getValidAccessToken(shop)
    if (!liveToken) return res.status(401).send('Shop access token missing or invalid. Re-install the app.')

    const shopifyProducts = await fetchShopifyProducts(shop, liveToken)
    const syncedCategory = await syncStoreCategoryFromProducts(store, shopifyProducts)
    const syncedPrimaryColor = store.primary_color || store.brands.primary_color || '#1B4332'
    await syncBrandAndStoreSettings({
      brandId: store.brands.brand_id,
      storeId: store.id,
      productCategory: syncedCategory || store.product_category || store.brands.product_category || 'general',
      primaryColor: syncedPrimaryColor
    })
    const storeBrand = {
      ...store.brands,
      product_category: syncedCategory || store.product_category || store.brands.product_category || 'general',
      primary_color: syncedPrimaryColor
    }
    const savedCount = await saveShopifyProducts(shop, storeBrand, shopifyProducts, store.id)

    try {
      await generateQuestionFlowForBrand(storeBrand, syncedCategory || 'general', { storeId: store.id })
      res.redirect(`${appUrl}/shopify?shop=${encodeURIComponent(shop)}&synced=${savedCount}`)
    } catch (questionError) {
      console.error('Shopify automatic question generation error:', questionError)
      const message = encodeURIComponent(questionError.message || 'Products synced, but question flow generation failed.')
      res.redirect(`${appUrl}/shopify?shop=${encodeURIComponent(shop)}&synced=${savedCount}&question_warning=${message}`)
    }
  } catch (error) {
    console.error('Shopify product sync error:', error.response?.data || error)
    const message = encodeURIComponent(error.response?.data?.errors || getErrorMessage(error, 'Product sync failed.'))
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
    if (!dashboard?.storeId) {
      return res.status(404).send('Shop is not connected to AlphaMark.')
    }

    await syncBrandAndStoreSettings({
      brandId: dashboard.brand?.brand_id,
      storeId: dashboard.storeId,
      productCategory: category,
      primaryColor
    })

    res.redirect(`${appUrl}/shopify?shop=${encodeURIComponent(shop)}&saved=1`)
  } catch (error) {
    console.error('Shopify settings update error:', error)
    res.status(500).send(getErrorMessage(error, 'Shopify settings update failed.'))
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

    const payload = new URLSearchParams({
      client_id: apiKey,
      client_secret: apiSecret,
      code,
      expiring: '1'
    })

    const tokenResponse = await axios.post(`https://${shop}/admin/oauth/access_token`, payload, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    })

    const tokenData = tokenResponse.data || {}
    const accessToken = tokenData.access_token
    const refreshToken = tokenData.refresh_token || null
    const expiresIn = tokenData.expires_in || null
    const refreshTokenExpiresIn = tokenData.refresh_token_expires_in || null
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null
    const refreshTokenExpiresAt = refreshTokenExpiresIn
      ? new Date(Date.now() + refreshTokenExpiresIn * 1000).toISOString()
      : null

    const brand = await findOrCreateShopBrand(shop)

    await upsertShopifyStore({
      shop_domain: shop,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt,
      refresh_token_expires_at: refreshTokenExpiresAt,
      scopes,
      brand_id: brand.brand_id,
      product_category: brand.product_category || 'general',
      primary_color: brand.primary_color || '#1B4332',
      installed_at: new Date().toISOString(),
      uninstalled_at: null
    })

    res.redirect(`${shopifyConfig().appUrl}/shopify?shop=${encodeURIComponent(shop)}`)
  } catch (error) {
    console.error('Shopify callback error:', error.response?.data || error)
    res.status(500).send(getErrorMessage(error.response?.data || error, 'Shopify callback failed.'))
  }
}

const getShopBrandConfig = async (req, res) => {
  try {
    const shop = req.query.shop

    if (!isValidShopDomain(shop)) {
      return res.status(400).json({ success: false, error: 'Valid shop is required.' })
    }

    let { data, error } = await supabase
      .from('shopify_stores')
      .select('shop_domain, product_category, primary_color, brands(product_category, primary_color)')
      .eq('shop_domain', shop)
      .is('uninstalled_at', null)
      .maybeSingle()

    if (isMissingStoreSettingsColumnError(error)) {
      const fallback = await supabase
        .from('shopify_stores')
        .select('shop_domain, brands(product_category, primary_color)')
        .eq('shop_domain', shop)
        .is('uninstalled_at', null)
        .maybeSingle()

      data = fallback.data ? { ...fallback.data, product_category: null, primary_color: null } : fallback.data
      error = fallback.error
    }

    if (error) throw error
    if (!data?.brands) {
      return res.status(404).json({ success: false, error: 'Shop is not connected to AlphaMark.' })
    }

    res.json({
      success: true,
      shop: data.shop_domain,
      brand_category: data.product_category || data.brands.product_category || 'general',
      primary_color: data.primary_color || data.brands.primary_color || '#1B4332'
    })
  } catch (error) {
    console.error('Shopify brand config error:', error)
    res.status(500).json({ success: false, error: getErrorMessage(error) })
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
    res.status(500).send(getErrorMessage(error, 'Shopify uninstall webhook failed.'))
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
    res.status(500).send(getErrorMessage(error, 'Shopify scopes update webhook failed.'))
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
