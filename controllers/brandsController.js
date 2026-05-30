const supabase = require('../config/supabase')

// Fetches the authenticated brand profile attached by the API-key middleware.
const getBrand = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('brands')
      .select('brand_id, name, slug, logo_url, product_category, primary_color')
      .eq('brand_id', req.brand.brand_id)
      .single()

    if (error) throw error

    res.json({ success: true, brand: data })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}

module.exports = { getBrand }
