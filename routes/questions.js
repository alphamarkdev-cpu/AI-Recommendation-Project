const express = require('express')
const router = express.Router()
const authenticateBrand = require('../middleware/auth')
const { getFixedQuestions, selectDynamicQuestions } = require('../controllers/questionsController')

// Returns the fixed onboarding questions used before AI selection.
router.get('/fixed', authenticateBrand, getFixedQuestions)
// Uses AI to select the most relevant dynamic questions for the user's profile.
router.post('/select', authenticateBrand, selectDynamicQuestions)

module.exports = router

