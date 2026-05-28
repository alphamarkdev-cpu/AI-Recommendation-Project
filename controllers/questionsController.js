const { GoogleGenerativeAI } = require('@google/generative-ai')
const supabase = require('../config/supabase')
require('dotenv').config()

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

// ── GET ALL FIXED QUESTIONS (personal + lifestyle) ──
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
const selectDynamicQuestions = async (req, res) => {
  try {
    const { personal_answers, lifestyle_answers, brand_category } = req.body

    if (!brand_category) {
      return res.status(400).json({ error: 'brand_category is required' })
    }

    // Step 1 — fetch all questions for this category from pool
    const { data: poolQuestions, error } = await supabase
      .from('question_bank')
      .select('*')
      .eq('category', brand_category)
      .eq('is_fixed', false)
      .order('display_order')

    if (error) throw error

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
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })
    const result = await model.generateContent(prompt)
    const responseText = result.response.text()
    const cleaned = responseText.replace(/```json|```/g, '').trim()
    const aiResponse = JSON.parse(cleaned)

    // Step 4 — fetch the selected questions in order
    const selectedIds = aiResponse.selected_question_ids
    const selectedQuestions = selectedIds
      .map(id => {
        const q = poolQuestions.find(q => q.question_id === id)
        if (q) {
          return {
            ...q,
            ai_reasoning: aiResponse.reasoning[id] || ''
          }
        }
        return null
      })
      .filter(Boolean)

    res.json({
      success: true,
      section: {
        section: brand_category,
        label: brand_category.charAt(0).toUpperCase() + brand_category.slice(1),
        questions: selectedQuestions
      },
      reasoning: aiResponse.reasoning
    })

  } catch (error) {
    console.error('Question selection error:', error)
    res.status(500).json({ error: error.message })
  }
}

module.exports = { getFixedQuestions, selectDynamicQuestions }


