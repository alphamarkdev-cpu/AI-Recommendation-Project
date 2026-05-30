const supabase = require('../config/supabase')

// Returns all active products for the authenticated brand, including ingredients and concern tags.
const getProducts = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select(`
        *,
        ingredients(*),
        concern_tags(*)
      `)
      .eq('brand_id', req.brand.brand_id)
      .eq('is_active', true)

    if (error) throw error

    res.json({ success: true, products: data })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}

// Finds and ranks active brand products that best match the user's selected types and concerns.
const getMatchingProducts = async (brandId, skinTypes, concerns) => {
  try {
    // fetch ALL active products for this brand
    const { data, error } = await supabase
      .from('products')
      .select(`
        *,
        ingredients(*),
        concern_tags(*)
      `)
      .eq('brand_id', brandId)
      .eq('is_active', true)

    if (error) throw error
    if (!data || data.length === 0) return []

    console.log('Total products for brand:', data.length)
    console.log('Filtering by concerns:', concerns)
    console.log('Filtering by skinTypes:', skinTypes)

    // filter by concern_tags — works for ALL categories
    let filtered = data.filter(product =>
      product.concern_tags.some(tag =>
        concerns.some(c =>
          tag.concern.toLowerCase().includes(c.toLowerCase()) ||
          c.toLowerCase().includes(tag.concern.toLowerCase())
        )
      )
    )

    console.log('After concern filter:', filtered.length)

    // if no concern match — try matching by suitable_skin_types
    if(filtered.length === 0){
      filtered = data.filter(product =>
        product.suitable_skin_types &&
        product.suitable_skin_types.some(st =>
          skinTypes.some(s =>
            st.toLowerCase().includes(s.toLowerCase()) ||
            s.toLowerCase().includes(st.toLowerCase())
          )
        )
      )
      console.log('After skin type filter:', filtered.length)
    }

    // if still nothing — return all products for this brand
    if(filtered.length === 0){
      console.log('No filter match — returning all brand products')
      filtered = data
    }

    // sort by priority score descending
    const sorted = filtered.sort((a, b) => {
      const aScore = a.concern_tags.length > 0
        ? Math.max(...a.concern_tags.map(t => t.priority_score || 0))
        : 0
      const bScore = b.concern_tags.length > 0
        ? Math.max(...b.concern_tags.map(t => t.priority_score || 0))
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
