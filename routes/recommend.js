const express = require('express')
const router = express.Router()
const authenticateBrand = require('../middleware/auth')
const { getRecommendation } = require('../controllers/recommendController')

router.post('/', authenticateBrand, getRecommendation)

module.exports = router

