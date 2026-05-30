const { GoogleGenerativeAI } = require('@google/generative-ai')
const supabase = require('../config/supabase')
const { formatGeminiUsage } = require('../utils/geminiUsage')
require('dotenv').config()

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

const emptyUsage = {
  input_tokens: 0,
  output_tokens: 0,
  thinking_tokens: 0,
  other_tokens: 0,
  total_tokens: 0,
  cached_tokens: 0
}

// Parses Gemini JSON output, including responses wrapped in markdown code fences.
const parseJsonResponse = text => {
  const cleaned = text.replace(/```json|```/g, '').trim()

  try {
    return JSON.parse(cleaned)
  } catch (error) {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')

    if (start === -1 || end === -1 || end <= start) {
      throw error
    }

    return JSON.parse(cleaned.slice(start, end + 1))
  }
}

// Builds the final dynamic-question response and fills any missing AI selections with fallback questions.
const buildQuestionResponse = (brandCategory, poolQuestions, selectedIds = [], reasoning = {}, aiUsage = emptyUsage) => {
  const used = new Set()
  const selectedQuestions = []

  selectedIds.forEach(id => {
    const q = poolQuestions.find(question => question.question_id === id)
    if (!q || used.has(q.question_id)) return

    used.add(q.question_id)
    selectedQuestions.push({
      ...q,
      ai_reasoning: reasoning[q.question_id] || ''
    })
  })

  poolQuestions.forEach(q => {
    if (selectedQuestions.length >= 5) return
    if (used.has(q.question_id)) return

    used.add(q.question_id)
    selectedQuestions.push({
      ...q,
      ai_reasoning: reasoning[q.question_id] || 'Fallback question selected to keep the assessment complete.'
    })
  })

  return {
    success: true,
    section: {
      section: brandCategory,
      label: brandCategory.charAt(0).toUpperCase() + brandCategory.slice(1),
      questions: selectedQuestions
    },
    reasoning,
    ai_usage: aiUsage
  }
}

// ── GET ALL FIXED QUESTIONS (personal + lifestyle) ──
// Returns fixed personal and lifestyle questions in the order they should appear in the widget.
const getFixedQuestions = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('question_bank')
      .select('*')
      .in('category', ['personal', 'lifestyle'])
      .eq('is_fixed', true)
      .order('category')
      .order('display_order')

    if (error) throw error

    // separate into two sections
    const personal = data.filter(q => q.category === 'personal')
    const lifestyle = data.filter(q => q.category === 'lifestyle')

    res.json({
      success: true,
      sections: [
        { section: 'personal', label: 'About You', questions: personal },
        { section: 'lifestyle', label: 'Lifestyle', questions: lifestyle }
      ]
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}

// ── AI SELECT DYNAMIC QUESTIONS ──
// Uses Gemini to choose the five most relevant category-specific questions for this user's profile.
const selectDynamicQuestions = async (req, res) => {
  const { personal_answers, lifestyle_answers, brand_category } = req.body
  let poolQuestions = []

  try {
    if (!brand_category) {
      return res.status(400).json({ error: 'brand_category is required' })
    }

    // Step 1 — fetch all questions for this category from pool
    const { data, error } = await supabase
      .from('question_bank')
      .select('*')
      .eq('category', brand_category)
      .eq('is_fixed', false)
      .order('display_order')

    if (error) throw error
    poolQuestions = data || []

    if (!poolQuestions || poolQuestions.length === 0) {
      return res.status(404).json({
        error: `No questions found for category: ${brand_category}`
      })
    }

    // Step 2 — build prompt for Gemini
    const prompt = `
You are an expert health and wellness advisor.

A consumer has provided the following personal and lifestyle information:

PERSONAL DETAILS:
${JSON.stringify(personal_answers, null, 2)}

LIFESTYLE DETAILS:
${JSON.stringify(lifestyle_answers, null, 2)}

BRAND CATEGORY: ${brand_category}

Below are ${poolQuestions.length} possible questions from our ${brand_category} question bank.
Each question has a question_id and field_key.
You must choose question_id values exactly as written in this pool.

QUESTION POOL:
${poolQuestions.map((q, i) => `
  ${i + 1}. question_id: "${q.question_id}"
     field_key: "${q.field_key}"
     question: "${q.question_text}"
`).join('')}

YOUR TASK:
Select exactly 5 questions from the pool above that are MOST RELEVANT for this specific consumer based on their personal and lifestyle profile.

Rules:
- If gender is Female, prioritise hormonal questions (PCOD, thyroid)
- If stress is high (4 or 5), prioritise stress-related questions
- If sleep is poor, prioritise questions related to deficiency
- If age is under 25, prioritise acne and early prevention questions
- If age is over 35, prioritise aging and hormonal questions
- Avoid redundant questions — pick diverse questions that cover different angles
- Always include the primary concern question for the category

Respond ONLY in this exact JSON format with no extra text:
{
  "selected_question_ids": ["uuid1", "uuid2", "uuid3", "uuid4", "uuid5"],
  "reasoning": {
    "uuid1": "one line reason why this question was selected",
    "uuid2": "one line reason",
    "uuid3": "one line reason",
    "uuid4": "one line reason",
    "uuid5": "one line reason"
  }
}
`

    // Step 3 — call Gemini
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
        maxOutputTokens: 1200
      }
    })
    const result = await model.generateContent(prompt)
    const aiUsage = formatGeminiUsage(result.response.usageMetadata)
    const responseText = result.response.text()
    const aiResponse = parseJsonResponse(responseText)

    console.log('Gemini token usage - question selection:', aiUsage)

    // Step 4 — fetch the selected questions in order
    const selectedIds = Array.isArray(aiResponse.selected_question_ids)
      ? aiResponse.selected_question_ids
      : []

    return res.json(buildQuestionResponse(
      brand_category,
      poolQuestions,
      selectedIds,
      aiResponse.reasoning || {},
      aiUsage
    ))

  } catch (error) {
    console.error('Question selection error:', error)

    if (!poolQuestions.length) {
      return res.status(500).json({
        success: false,
        error: error.message
      })
    }

    return res.json(buildQuestionResponse(
      brand_category,
      poolQuestions,
      [],
      {},
      emptyUsage
    ))
  }
  
}

module.exports = { getFixedQuestions, selectDynamicQuestions }


