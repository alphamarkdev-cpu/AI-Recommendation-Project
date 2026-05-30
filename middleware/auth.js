const supabase = require('../config/supabase')

// Validates the x-api-key header and attaches the matching active brand to the request.
const authenticateBrand = async (req, res, next) => {
  const apiKey = req.headers['x-api-key']

  if (!apiKey) {
    return res.status(401).json({ error: 'API key is required' })
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
}

module.exports = authenticateBrand


