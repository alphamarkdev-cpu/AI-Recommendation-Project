const express = require('express')
const router = express.Router()
const authenticateBrand = require('../middleware/auth')
const { getFixedQuestions, selectDynamicQuestions } = require('../controllers/questionsController')

router.get('/fixed', authenticateBrand, getFixedQuestions)
router.post('/select', authenticateBrand, selectDynamicQuestions)

module.exports = router

