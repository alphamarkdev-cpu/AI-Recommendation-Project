const express = require('express')
const router = express.Router()
const authenticateBrand = require('../middleware/auth')
const { getBrand } = require('../controllers/brandsController')

router.get('/me', authenticateBrand, getBrand)

module.exports = router