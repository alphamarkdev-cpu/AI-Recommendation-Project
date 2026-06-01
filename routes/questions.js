const express = require('express')
const router = express.Router()
const authenticateBrand = require('../middleware/auth')
const { getFixedQuestions, getActiveQuestionFlow, generateQuestionFlow, selectDynamicQuestions } = require('../controllers/questionsController')

// Generates a new stored question flow from the brand's current product database.
router.post('/flow/generate', authenticateBrand, generateQuestionFlow)
// Returns the active pre-generated brand question flow without calling AI.
router.get('/flow', authenticateBrand, getActiveQuestionFlow)
// Returns the fixed onboarding questions used before AI selection.
router.get('/fixed', authenticateBrand, getFixedQuestions)
// Uses AI to select the most relevant dynamic questions for the user's profile.
router.post('/select', authenticateBrand, selectDynamicQuestions)

module.exports = router

