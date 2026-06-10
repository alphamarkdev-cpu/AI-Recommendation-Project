const express = require('express')
const router = express.Router()
const authenticateBrand = require('../middleware/auth')
const { getRecommendation } = require('../controllers/recommendController')

const asyncRoute = handler => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next)
}

// Generates a personalized recommendation for the authenticated brand.
router.post('/', asyncRoute(authenticateBrand), asyncRoute(getRecommendation))

module.exports = router

