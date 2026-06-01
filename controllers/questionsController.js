const { GoogleGenerativeAI } = require('@google/generative-ai')
const supabase = require('../config/supabase')
const { formatGeminiUsage } = require('../utils/geminiUsage')
require('dotenv').config()

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

// Runs Gemini generation with retries because onboarding flow generation is a one-time admin action.
const generateWithRetry = async (model, prompt, attempts = 3) => {
  let lastError

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await model.generateContent(prompt)
    } catch (error) {
      lastError = error
      console.error(`Gemini generation attempt ${attempt} failed:`, {
        message: error.message,
        status: error.status,
        statusText: error.statusText
      })

      if (attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, attempt * 1500))
      }
    }
  }

  throw lastError
}

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

// Repairs malformed Gemini JSON by asking the model to return only valid JSON.
const repairJsonResponse = async (model, brokenJson, parseError) => {
  const repairPrompt = `
The following text was intended to be JSON, but JSON.parse failed with:
${parseError.message}

Repair the text into valid JSON.

Rules:
- Return ONLY valid JSON.
- Do not add markdown.
- Do not explain anything.
- Preserve all keys and values as much as possible.
- Keep the same top-level shape.

BROKEN JSON:
${brokenJson}
`

  const repairedResult = await generateWithRetry(model, repairPrompt, 2)
  return parseJsonResponse(repairedResult.response.text())
}

// Parses Gemini output and falls back to one repair pass when JSON is malformed.
const parseJsonResponseWithRepair = async (model, text) => {
  try {
    return parseJsonResponse(text)
  } catch (error) {
    console.error('Initial Gemini JSON parse failed:', error.message)
    return repairJsonResponse(model, text, error)
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
// Returns the active pre-generated question flow for the authenticated brand and category.
// Builds a deterministic fallback flow from product concerns when Gemini generation is unavailable.
const buildFallbackFlow = (category, products) => {
  const concernSet = new Set()
  const typeSet = new Set()

  products.forEach(product => {
    ;(product.concern_tags || []).forEach(tag => {
      if (tag.concern) concernSet.add(tag.concern)
    })
    ;(product.suitable_skin_types || []).forEach(type => {
      if (type) typeSet.add(type)
    })
  })

  const concernOptions = Array.from(concernSet).slice(0, 8)
  const typeOptions = Array.from(typeSet).slice(0, 6)
  const concerns = concernOptions.length ? concernOptions : ['Acne', 'Oiliness', 'Dryness', 'Sensitivity']
  const types = typeOptions.length ? typeOptions : ['Oily', 'Dry', 'Combination', 'Sensitive']

  const questions_json = [
    { question_id: 'q1', field_key: 'primary_concern', question_text: 'What is your main concern right now?', sub_text: 'Choose the closest match so we can route your assessment.', input_type: 'chips', options_json: concerns, category, section_label: 'Assessment' },
    { question_id: 'q2', field_key: 'skin_type', question_text: 'Which type describes you best?', sub_text: 'This helps us avoid products that may feel too heavy or too drying.', input_type: 'cards', options_json: types.map(type => ({ label: type, emoji: '', sub: '' })), category, section_label: 'Assessment' },
    { question_id: 'q3', field_key: 'concern_severity', question_text: 'How intense is this concern currently?', sub_text: 'Use 1 for mild and 5 for very intense.', input_type: 'scale', options_json: [1, 2, 3, 4, 5], category, section_label: 'Assessment' },
    { question_id: 'q4', field_key: 'concern_duration', question_text: 'How long has this concern been present?', sub_text: 'A rough estimate is enough.', input_type: 'chips', options_json: ['Less than 1 month', '1-3 months', '3-6 months', 'More than 6 months'], category, section_label: 'Assessment' },
    { question_id: 'q5', field_key: 'known_triggers', question_text: 'What usually triggers or worsens it?', sub_text: 'Choose the strongest trigger.', input_type: 'chips', options_json: ['Stress', 'Sleep', 'Diet', 'Weather', 'Products', 'Not sure'], category, section_label: 'Assessment' },
    { question_id: 'q6', field_key: 'previous_treatments', question_text: 'Have you already tried anything for this?', sub_text: 'Mention products, treatments, or home remedies.', input_type: 'text', options_json: { placeholder: 'Example: salicylic acid face wash, dermatologist cream...' }, category, section_label: 'Assessment' },
    { question_id: 'q7', field_key: 'allergies', question_text: 'Any allergies or ingredients you avoid?', sub_text: 'This helps us filter unsafe recommendations.', input_type: 'text', options_json: { placeholder: 'Write none if there are no known allergies' }, category, section_label: 'Assessment' },
    { question_id: 'q8', field_key: 'budget', question_text: 'What budget range feels comfortable?', sub_text: 'We will keep recommendations practical.', input_type: 'chips', options_json: ['Under 500', '500-1000', '1000-2000', 'No strict budget'], category, section_label: 'Assessment' }
  ]

  return {
    questions_json,
    flow_json: {
      start: 'q1',
      nodes: {
        q1: { default: 'q2' },
        q2: { default: 'q3' },
        q3: { default: 'q4' },
        q4: { default: 'q5' },
        q5: { default: 'q6' },
        q6: { default: 'q7' },
        q7: { default: 'q8' },
        q8: { next: 'END' }
      }
    }
  }
}

const getActiveQuestionFlow = async (req, res) => {
  try {
    const category = req.query.category || req.query.brand_category

    if (!category) {
      return res.status(400).json({ error: 'category is required' })
    }

    const { data, error } = await supabase
      .from('brand_question_flows')
      .select('flow_id, brand_id, category, version, questions_json, flow_json, is_active, updated_at')
      .eq('brand_id', req.brand.brand_id)
      .eq('category', category)
      .eq('is_active', true)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({
        success: false,
        error: `No active question flow found for category: ${category}`
      })
    }

    res.json({
      success: true,
      flow: data
    })
  } catch (error) {
    console.error('Question flow error:', error)
    res.status(500).json({ error: error.message })
  }
}

// Generates and stores a new brand question flow from the brand's current product catalogue.
const generateQuestionFlow = async (req, res) => {
  try {
    const category = req.body.category || req.body.brand_category || req.brand.product_category || 'skincare'
    const brandId = req.brand.brand_id

    const { data: products, error: productsError } = await supabase
      .from('products')
      .select(`
        name,
        category,
        description,
        suitable_skin_types,
        ingredients(name),
        concern_tags(concern, severity_level, priority_score)
      `)
      .eq('brand_id', brandId)
      .eq('is_active', true)

    if (productsError) throw productsError
    if (!products || products.length === 0) {
      return res.status(404).json({ error: 'No active products found for this brand.' })
    }

    const productContext = products.map(product => ({
      name: product.name,
      category: product.category,
      description: product.description,
      suitable_skin_types: product.suitable_skin_types,
      ingredients: product.ingredients.map(ingredient => ingredient.name),
      concerns: product.concern_tags.map(tag => ({
        concern: tag.concern,
        severity_level: tag.severity_level,
        priority_score: tag.priority_score
      }))
    }))

    const prompt = `
You are building a stored decision-tree questionnaire for ${req.brand.name}.

BRAND CATEGORY: ${category}

PRODUCTS AND CONCERNS:
${JSON.stringify(productContext, null, 2)}

Create a reusable question flow that can run without calling AI during the user's quiz session.

Rules:
- Generate exactly 8 questions.
- Questions must identify the user's main concern, type, severity, triggers, history, budget, allergies, and routine habits.
- Use only these input_type values: "chips", "cards", "scale", "text".
- Use concise consumer-friendly wording.
- Every question must have a stable question_id like "q1", "q2", etc.
- Every field_key must be lowercase snake_case.
- flow_json must be a simple decision tree.
- The tree must start with "q1".
- Branch using answer text exactly as it appears in options_json.
- Use "END" when the quiz should go to photo/recommendation.

Respond ONLY in this exact JSON shape:
{
  "questions_json": [
    {
      "question_id": "q1",
      "field_key": "primary_concern",
      "question_text": "What is your main concern right now?",
      "sub_text": "Choose the closest match.",
      "input_type": "chips",
      "options_json": ["Acne", "Oily skin", "Dryness"],
      "category": "${category}",
      "section_label": "Assessment"
    }
  ],
  "flow_json": {
    "start": "q1",
    "nodes": {
      "q1": {
        "if": {
          "Acne": "q2",
          "Oily skin": "q3"
        },
        "default": "q4"
      },
      "q8": {
        "next": "END"
      }
    }
  }
}
`

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
        maxOutputTokens: 3000
      }
    })
    let aiUsage = emptyUsage
    let flow
    let usedFallback = false

    try {
      const result = await generateWithRetry(model, prompt)
      aiUsage = formatGeminiUsage(result.response.usageMetadata)
      flow = await parseJsonResponseWithRepair(model, result.response.text())
    } catch (error) {
      console.error('Gemini flow generation failed. Using deterministic fallback flow:', error.message)
      flow = buildFallbackFlow(category, products)
      usedFallback = true
    }

    if (!Array.isArray(flow.questions_json) || !flow.flow_json) {
      console.error('AI did not return a valid question flow shape. Using deterministic fallback flow.')
      flow = buildFallbackFlow(category, products)
      aiUsage = emptyUsage
      usedFallback = true
    }

    const { data: latestFlow, error: latestError } = await supabase
      .from('brand_question_flows')
      .select('version')
      .eq('brand_id', brandId)
      .eq('category', category)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (latestError) throw latestError

    const nextVersion = (latestFlow?.version || 0) + 1

    const { error: deactivateError } = await supabase
      .from('brand_question_flows')
      .update({ is_active: false })
      .eq('brand_id', brandId)
      .eq('category', category)
      .eq('is_active', true)

    if (deactivateError) throw deactivateError

    const { data: savedFlow, error: saveError } = await supabase
      .from('brand_question_flows')
      .insert({
        brand_id: brandId,
        category,
        version: nextVersion,
        questions_json: flow.questions_json,
        flow_json: flow.flow_json,
        is_active: true
      })
      .select('flow_id, brand_id, category, version, is_active, updated_at')
      .single()

    if (saveError) throw saveError

    res.json({
      success: true,
      flow: savedFlow,
      fallback_used: usedFallback,
      ai_usage: aiUsage
    })
  } catch (error) {
    console.error('Generate question flow error:', error)
    res.status(500).json({ error: error.message })
  }
}

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

module.exports = { getFixedQuestions, getActiveQuestionFlow, generateQuestionFlow, selectDynamicQuestions }


