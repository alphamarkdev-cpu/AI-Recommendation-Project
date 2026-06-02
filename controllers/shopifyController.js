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

const createBrandForShop = async shop => {
  const slug = shopSlug(shop)
  const apiKey = `shop_${crypto.randomBytes(18).toString('hex')}`

  const { data, error } = await supabase
    .from('brands')
    .insert({
      name: slug.replace(/-/g, ' '),
      slug,
      api_key: apiKey,
      product_category: 'skincare',
      primary_color: '#1B4332',
      is_active: true
    })
    .select('brand_id, api_key, product_category')
    .single()

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

    res.redirect(`https://${shop}/admin/apps/${apiKey}`)
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
      brand_category: data.brands.product_category || 'skincare',
      primary_color: data.brands.primary_color || '#1B4332'
    })
  } catch (error) {
    console.error('Shopify brand config error:', error)
    res.status(500).json({ success: false, error: error.message })
  }
}

const shopifyHealth = (req, res) => {
  res.send('AlphaMark Shopify app is running.')
}

module.exports = {
  startShopifyInstall,
  handleShopifyCallback,
  getShopBrandConfig,
  shopifyHealth
}
