const express = require('express')
const router = express.Router()
const authenticateBrand = require('../middleware/auth')
const dashboardController = require('../controllers/dashboardController')

// Serve the dashboard HTML (will require brand API key or shop header)
router.get('/page', authenticateBrand, dashboardController.dashboardPage)

// Unauthenticated helper: accepts `api_key` as query param, sets a short-lived cookie
// and redirects to the dashboard page so the browser can work without manual header tools.
router.get('/auth', async (req, res) => {
	try {
		const apiKey = req.query.api_key
		if (!apiKey) return res.status(400).json({ error: 'api_key query parameter is required' })

		const supabase = require('../config/supabase')
		const { data: brand, error } = await supabase
			.from('brands')
			.select('brand_id, api_key, is_active')
			.eq('api_key', apiKey)
			.single()

		if (error || !brand || !brand.is_active) {
			return res.status(401).json({ error: 'Invalid or inactive API key' })
		}

		// Set cookie for same-origin requests (not secure by default for localhost)
		res.setHeader('Set-Cookie', `alpha_api_key=${encodeURIComponent(apiKey)}; Path=/; Max-Age=3600; SameSite=Lax`)
		// Also include api_key in the redirect query so the SPA can pick it up
		return res.redirect(`/api/dashboard/page?api_key=${encodeURIComponent(apiKey)}`)
	} catch (err) {
		return res.status(500).json({ error: err.message })
	}
})

// API endpoints (brand-scoped via authenticateBrand)
router.get('/overview', authenticateBrand, dashboardController.getOverview)
router.get('/products', authenticateBrand, dashboardController.getProducts)
router.get('/questions', authenticateBrand, dashboardController.getQuestions)
router.get('/customers', authenticateBrand, dashboardController.getCustomerAnalytics)
router.get('/recommendations', authenticateBrand, dashboardController.getRecommendationAnalytics)
router.get('/revenue', authenticateBrand, dashboardController.getRevenue)
router.get('/ai', authenticateBrand, dashboardController.getAiUsage)

module.exports = router
