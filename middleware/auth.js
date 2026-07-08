const supabase = require('../config/supabase')

const isValidShopDomain = shop => (
  typeof shop === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)
)

const getRequestShop = req => (
  req.headers['x-shop-domain'] ||
  req.query.shop ||
  req.query.shop_domain ||
  req.body?.shop ||
  req.body?.shop_domain ||
  ''
)

const getCookie = (req, name) => {
  const header = req.headers?.cookie || ''
  if (!header) return null
  const parts = header.split(';').map(p => p.trim())
  const pair = parts.find(p => p.startsWith(name + '='))
  if (!pair) return null
  return decodeURIComponent(pair.split('=').slice(1).join('='))
}

const authenticateShopifyStore = async shop => {
  if (!isValidShopDomain(shop)) return null

  const { data: store, error } = await supabase
    .from('shopify_stores')
    .select('id, shop_domain, brand_id, product_category, primary_color, brands(*)')
    .eq('shop_domain', shop)
    .is('uninstalled_at', null)
    .maybeSingle()

  if (error) throw error
  if (!store?.brands?.is_active) return null

  return store
}

// Resolves public widget requests by Shopify store first, then falls back to legacy brand API keys.
const authenticateBrand = async (req, res, next) => {
  try {
    const shop = getRequestShop(req)
    const store = await authenticateShopifyStore(shop)

    if (store) {
      req.shopifyStore = {
        id: store.id,
        shop_domain: store.shop_domain,
        brand_id: store.brand_id,
        product_category: store.product_category || store.brands.product_category || 'general',
        primary_color: store.primary_color || store.brands.primary_color || '#1B4332'
      }
      req.brand = store.brands
      return next()
    }

    // Allow API key via header or cookie (so browser redirect auth works)
    const apiKey = req.headers['x-api-key'] || getCookie(req, 'alpha_api_key')

    if (!apiKey) {
      return res.status(401).json({ error: 'A connected Shopify shop or API key is required' })
    }

    const { data: brand, error } = await supabase
      .from('brands')
      .select('*')
      .eq('api_key', apiKey)
      .eq('is_active', true)
      .single()

    if (error || !brand) {
      return res.status(401).json({ error: 'Invalid or inactive API key' })
    }

    req.brand = brand
    next()
  } catch (error) {
    next(error)
  }
}

module.exports = authenticateBrand

