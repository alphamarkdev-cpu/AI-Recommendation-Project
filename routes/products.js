const express = require('express')
const router = express.Router()
const authenticateBrand = require('../middleware/auth')
const { getProducts } = require('../controllers/productsController')

// Exposes active products for the authenticated brand.
router.get('/', authenticateBrand, getProducts)

module.exports = router
