const supabase = require('../config/supabase')

const getErrorMessage = error => {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string') return error
  if (typeof error?.message === 'string') return error.message
  return ''
}

const isMissingProductsStoreIdError = error => {
  const message = getErrorMessage(error)
  return (
    message.includes(`'store_id'`) &&
    message.includes(`'products'`) &&
    message.includes('schema cache')
  ) || (
    message.includes('products.store_id') &&
    message.includes('does not exist')
  ) || (
    message.includes('column products.store_id does not exist')
  )
}

const scopeProductsQuery = (query, brandId, storeId) => {
  const scopedQuery = query.eq('brand_id', brandId)
  return storeId ? scopedQuery.eq('store_id', storeId) : scopedQuery
}

// Returns all active products for the authenticated brand, including components and match tags.
const getProducts = async (req, res) => {
  try {
    const query = supabase
      .from('products')
      .select(`
        *,
        product_components(*),
        product_match_tags(*)
      `)
      .eq('is_active', true)

    let { data, error } = await scopeProductsQuery(
      query,
      req.brand.brand_id,
      req.shopifyStore?.id
    )

    if (isMissingProductsStoreIdError(error)) {
      const fallback = await supabase
        .from('products')
        .select(`
          *,
          product_components(*),
          product_match_tags(*)
        `)
        .eq('is_active', true)
        .eq('brand_id', req.brand.brand_id)

      data = fallback.data
      error = fallback.error
    }

    if (error) throw error

    res.json({ success: true, products: data })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}

// Finds and ranks active brand products that best match the user's selected profile attributes and concerns.
const getMatchingProducts = async (brandId, profileTypes, concerns, storeId = null) => {
  try {
    // fetch ALL active products for this brand
    const query = supabase
      .from('products')
      .select(`
        *,
        product_components(*),
        product_match_tags(*)
      `)
      .eq('is_active', true)

    let { data, error } = await scopeProductsQuery(query, brandId, storeId)

    if (isMissingProductsStoreIdError(error)) {
      const fallback = await supabase
        .from('products')
        .select(`
          *,
          product_components(*),
          product_match_tags(*)
        `)
        .eq('is_active', true)
        .eq('brand_id', brandId)

      data = fallback.data
      error = fallback.error
    }

    if (error) throw error
    if (!data || data.length === 0) return []

    console.log('Total products for brand:', data.length)
    console.log('Filtering by concerns:', concerns)
    console.log('Filtering by profile attributes:', profileTypes)

    // filter by product match tags — works for all categories
    let filtered = data.filter(product =>
      (product.product_match_tags || []).some(tag =>
        concerns.some(c =>
          String(tag.match_tag || '').toLowerCase().includes(String(c || '').toLowerCase()) ||
          String(c || '').toLowerCase().includes(String(tag.match_tag || '').toLowerCase())
        )
      )
    )

    console.log('After concern filter:', filtered.length)

    // if no match-tag hit, try generic customer/product attributes.
    if(filtered.length === 0){
      filtered = data.filter(product =>
        product.suitable_customer_attributes &&
        product.suitable_customer_attributes.some(st =>
          profileTypes.some(s =>
            st.toLowerCase().includes(s.toLowerCase()) ||
            s.toLowerCase().includes(st.toLowerCase())
          )
        )
      )
      console.log('After profile attribute filter:', filtered.length)
    }

    // if still nothing — return all products for this brand
    if(filtered.length === 0){
      console.log('No filter match — returning all brand products')
      filtered = data
    }

    // sort by priority score descending
    const sorted = filtered.sort((a, b) => {
      const aTags = a.product_match_tags || []
      const bTags = b.product_match_tags || []
      const aScore = aTags.length > 0
        ? Math.max(...aTags.map(t => t.priority_score || 0))
        : 0
      const bScore = bTags.length > 0
        ? Math.max(...bTags.map(t => t.priority_score || 0))
        : 0
      return bScore - aScore
    })

    console.log('Final matched products:', sorted.map(p => p.name))
    return sorted

  } catch (error) {
    console.error('getMatchingProducts error:', error)
    throw error
  }
}
module.exports = { getProducts, getMatchingProducts }
