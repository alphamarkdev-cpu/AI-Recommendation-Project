const express = require('express')
const router = express.Router()
const authenticateBrand = require('../middleware/auth')
const { getRecommendation } = require('../controllers/recommendController')

// Generates a personalized recommendation for the authenticated brand.
router.post('/', authenticateBrand, getRecommendation)

module.exports = router

