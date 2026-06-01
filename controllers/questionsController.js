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

const GENERATED_QUESTION_COUNT = 14
const MIN_GENERATED_QUESTIONS = 12
const MIN_BRANCHING_NODES = 4

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

// Keeps only valid generated question fields and gives every question a predictable ID.
const normaliseGeneratedQuestions = (questions = [], category) => {
  if (!Array.isArray(questions)) return []

  return questions
    .slice(0, 30)
    .map((question, index) => ({
      question_id: question.question_id || `q${index + 1}`,
      field_key: question.field_key || `question_${index + 1}`,
      question_text: question.question_text || question.question || question.text || '',
      sub_text: question.sub_text || question.description || '',
      input_type: ['chips', 'cards', 'scale', 'text'].includes(question.input_type)
        ? question.input_type
        : 'chips',
      options_json: question.options_json || question.options || [],
      category: question.category || category,
      section_label: question.section_label || 'Assessment'
    }))
    .filter(question => question.question_text && question.field_key)
}

// Creates a simple linear flow for a valid question list.
const buildLinearFlow = questions => ({
  start: questions[0]?.question_id || 'q1',
  nodes: questions.reduce((nodes, question, index) => {
    const nextQuestion = questions[index + 1]
    nodes[question.question_id] = nextQuestion
      ? { default: nextQuestion.question_id }
      : { next: 'END' }
    return nodes
  }, {})
})

// Converts stored option data into the exact answer strings used by the widget.
const optionLabels = question => {
  if (question.input_type === 'scale') return ['1', '2', '3', '4', '5']
  if (question.input_type === 'text') return []

  const options = Array.isArray(question.options_json) ? question.options_json : []
  return options
    .map(option => {
      if (option && typeof option === 'object') {
        return option.label || option.value || option.text || ''
      }
      return String(option || '')
    })
    .filter(Boolean)
}

// Gives Gemini a compact routing schema with the valid answer labels for each question.
const buildFlowPromptQuestions = questions => questions.map((question, index) => ({
  question_id: question.question_id,
  order: index + 1,
  field_key: question.field_key,
  input_type: question.input_type,
  question_text: question.question_text,
  answer_values_for_if: optionLabels(question),
  next_linear_question_id: questions[index + 1]?.question_id || 'END'
}))

// Validates Gemini routing against the stored questions and widget-supported node shape.
const normaliseGeneratedFlow = (flowJson, questions) => {
  const questionIds = new Set(questions.map(question => question.question_id))
  const validTargets = new Set([...questionIds, 'END'])
  const firstQuestionId = questions[0]?.question_id

  if (!flowJson || typeof flowJson !== 'object' || Array.isArray(flowJson)) {
    throw new Error('Gemini flow_json must be an object.')
  }

  const nodes = flowJson.nodes
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) {
    throw new Error('Gemini flow_json.nodes must be an object.')
  }

  const normalised = {
    start: questionIds.has(flowJson.start) ? flowJson.start : firstQuestionId,
    nodes: {}
  }

  questions.forEach((question, index) => {
    const node = nodes[question.question_id]
    const nextQuestion = questions[index + 1]
    const fallbackTarget = nextQuestion?.question_id || 'END'

    if (typeof node === 'string') {
      normalised.nodes[question.question_id] = validTargets.has(node)
        ? { next: node }
        : { default: fallbackTarget }
      return
    }

    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      normalised.nodes[question.question_id] = nextQuestion
        ? { default: fallbackTarget }
        : { next: 'END' }
      return
    }

    const cleanedNode = {}

    if (node.if && typeof node.if === 'object' && !Array.isArray(node.if)) {
      const cleanedIf = {}
      Object.entries(node.if).forEach(([answer, target]) => {
        if (validTargets.has(target)) cleanedIf[answer] = target
      })
      if (Object.keys(cleanedIf).length) cleanedNode.if = cleanedIf
    }

    if (validTargets.has(node.default)) cleanedNode.default = node.default
    if (validTargets.has(node.next)) cleanedNode.next = node.next

    if (!cleanedNode.if && !cleanedNode.default && !cleanedNode.next) {
      if (nextQuestion) cleanedNode.default = fallbackTarget
      else cleanedNode.next = 'END'
    }

    normalised.nodes[question.question_id] = cleanedNode
  })

  if (normalised.start !== firstQuestionId) {
    throw new Error('Gemini flow_json.start must be the first generated question_id.')
  }

  return normalised
}

const countBranchingNodes = flowJson => Object.values(flowJson.nodes || {})
  .filter(node => node?.if && Object.keys(node.if).length >= 2)
  .length

const assertGeneratedQuestionBank = questions => {
  if (questions.length < MIN_GENERATED_QUESTIONS) {
    throw new Error(`Gemini returned only ${questions.length} questions; expected at least ${MIN_GENERATED_QUESTIONS}.`)
  }

  if (questions[0]?.question_id !== 'q1' || questions[0]?.field_key !== 'primary_concern') {
    throw new Error('Gemini must start with q1 using field_key primary_concern.')
  }

  const primaryConcernOptions = optionLabels(questions[0])
  if (primaryConcernOptions.length < 3) {
    throw new Error('Gemini primary_concern question must include at least 3 concern options.')
  }
}

const assertGeneratedDecisionTree = flowJson => {
  const branchCount = countBranchingNodes(flowJson)
  if (branchCount < MIN_BRANCHING_NODES) {
    throw new Error(`Gemini returned only ${branchCount} branching nodes; expected at least ${MIN_BRANCHING_NODES}.`)
  }

  const firstNode = flowJson.nodes?.q1
  if (!firstNode?.if || Object.keys(firstNode.if).length < 3) {
    throw new Error('Gemini q1 must branch to at least 3 concern-specific paths.')
  }
}

// Accepts common Gemini shapes and returns the generated questions array.
const extractQuestionsFromAi = aiResponse => {
  if (Array.isArray(aiResponse)) return aiResponse
  return aiResponse.questions_json || aiResponse.questions || aiResponse.question_flow || []
}

// Accepts common Gemini shapes and returns the generated flow object.
const extractFlowFromAi = aiResponse => aiResponse.flow_json || aiResponse.flow || aiResponse.decision_tree || null

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

    const productContext = products.slice(0, 20).map(product => ({
      name: product.name,
      category: product.category,
      suitable_skin_types: product.suitable_skin_types,
      concerns: product.concern_tags.map(tag => tag.concern)
    }))
    const catalogueConcerns = Array.from(new Set(
      products.flatMap(product => (product.concern_tags || []).map(tag => tag.concern).filter(Boolean))
    )).slice(0, 10)

    const questionsPrompt = `
You are building reusable quiz questions for ${req.brand.name}.

BRAND CATEGORY: ${category}

PRODUCTS AND CONCERNS:
${JSON.stringify(productContext, null, 2)}

CATALOGUE CONCERNS:
${JSON.stringify(catalogueConcerns)}

Create a reusable routed question bank that can run without calling AI during the user's quiz session.

COUNT AND COVERAGE RULES:
- Generate exactly ${GENERATED_QUESTION_COUNT} question objects in questions_json.
- Do not generate 2, 8, 10, or 18 questions. The response is invalid unless questions_json.length is exactly ${GENERATED_QUESTION_COUNT}.
- q1 must ask the user's biggest concern and must use field_key "primary_concern".
- q1 options must include at least 4 main concerns supported by the product catalogue.
- q2-q10 must be concern-specific follow-up questions grouped across the main concerns from q1.
- q11-q14 must be shared final questions for allergies/avoided ingredients, previous treatments, routine habits, and budget.
- Not every user should answer every question. The flow_json will later choose one relevant path.
- Design the bank so a user path can contain 5 to 8 questions while the database stores all ${GENERATED_QUESTION_COUNT}.

QUESTION CONTENT RULES:
- Create different follow-up paths for concerns such as acne/breakouts, oily skin, dark spots/pigmentation, dryness, sensitivity, aging, dullness, or any other concerns found in the product catalogue.
- Include severity, duration, subtype, triggers, and sensitivity follow-ups where relevant.
- Use only these input_type values: "chips", "cards", "scale", "text".
- Use concise consumer-friendly wording.
- Every question must have a stable question_id like "q1", "q2", etc.
- Use sequential question_id values from q1 through q${GENERATED_QUESTION_COUNT} without gaps.
- Every field_key must be lowercase snake_case.
- For chips/cards, options_json must be an array.
- For scale, options_json must be [1,2,3,4,5].
- For text, options_json must be an object with a placeholder.
- Use answer option labels that are easy to branch on later.

Return ONLY valid JSON in this shape:
{
  "questions_json": [
    {
      "question_id": "q1",
      "field_key": "primary_concern",
      "question_text": "...",
      "sub_text": "...",
      "input_type": "chips",
      "options_json": ["...", "..."],
      "category": "${category}",
      "section_label": "Assessment"
    }
  ]
}

The questions_json array in your real response must contain q1 through q${GENERATED_QUESTION_COUNT} as ${GENERATED_QUESTION_COUNT} complete objects.
`

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.25,
        maxOutputTokens: 4500
      }
    })
    let aiUsage = emptyUsage
    let flow
    let usedFallback = false
    let fallbackReason = null

    try {
      let questionsResult = await generateWithRetry(model, questionsPrompt)
      let questionsUsage = formatGeminiUsage(questionsResult.response.usageMetadata)
      let questionsResponse = await parseJsonResponseWithRepair(model, questionsResult.response.text())
      let questions = normaliseGeneratedQuestions(extractQuestionsFromAi(questionsResponse), category)

      if (!questions.length) {
        throw new Error('Gemini did not return usable questions.')
      }

      try {
        assertGeneratedQuestionBank(questions)
      } catch (qualityError) {
        if (questions.length >= MIN_GENERATED_QUESTIONS) throw qualityError

        const retryPrompt = `
Your previous response returned only ${questions.length} usable questions.

Regenerate the complete question bank now.

Rules:
- Return ONLY valid JSON.
- Top-level key must be "questions_json".
- questions_json must contain exactly ${GENERATED_QUESTION_COUNT} complete question objects.
- Use question_id values q1 through q${GENERATED_QUESTION_COUNT} with no gaps.
- q1 field_key must be "primary_concern" and must have at least 4 concern options.
- q2-q10 must be concern-specific follow-up questions.
- q11-q14 must be shared final questions: allergies/avoided ingredients, previous treatments, routine habits, and budget.
- Use only input_type: "chips", "cards", "scale", "text".
- Do not include markdown or explanations.

BRAND CATEGORY: ${category}
CATALOGUE CONCERNS: ${JSON.stringify(catalogueConcerns)}
`

        questionsResult = await generateWithRetry(model, retryPrompt, 2)
        const retryUsage = formatGeminiUsage(questionsResult.response.usageMetadata)
        questionsUsage = {
          input_tokens: questionsUsage.input_tokens + retryUsage.input_tokens,
          output_tokens: questionsUsage.output_tokens + retryUsage.output_tokens,
          thinking_tokens: questionsUsage.thinking_tokens + retryUsage.thinking_tokens,
          other_tokens: questionsUsage.other_tokens + retryUsage.other_tokens,
          total_tokens: questionsUsage.total_tokens + retryUsage.total_tokens,
          cached_tokens: questionsUsage.cached_tokens + retryUsage.cached_tokens
        }
        questionsResponse = await parseJsonResponseWithRepair(model, questionsResult.response.text())
        questions = normaliseGeneratedQuestions(extractQuestionsFromAi(questionsResponse), category)
        assertGeneratedQuestionBank(questions)
      }

      const flowPrompt = `
You are creating the stored routing JSON for the AlphaMark quiz widget.

DATABASE COLUMN:
- The result will be saved directly into brand_question_flows.flow_json as JSONB.

WIDGET ROUTING CONTRACT:
- flow_json must be an object with exactly this shape:
  {
    "start": "q1",
    "nodes": {
      "q1": { "if": { "Answer label": "q2" }, "default": "q2" },
      "q8": { "next": "END" }
    }
  }
- "start" must equal the first question_id: "${questions[0].question_id}".
- "nodes" must contain one key for every question_id.
- Each node may contain only "if", "default", and/or "next".
- "if" must be an object whose keys are answer values and whose values are question_id targets or "END".
- "default" must be one question_id target or "END".
- "next" must be one question_id target or "END".
- Every target must be one of the provided question_id values or "END".
- Do not use arrays, explanations, labels, conditions, operators, field_key values, or nested objects as targets.

ANSWER VALUE RULES:
- For chips and cards, use only the exact strings from answer_values_for_if.
- For scale, use only the strings "1", "2", "3", "4", "5".
- For text questions, do not create "if" branches because free text cannot be matched reliably. Use "default" or "next".

FLOW RULES:
- Keep the quiz short and safe: no loops, no backwards jumps, and never route a question back to itself.
- Create an actual decision tree where a user answers only the questions relevant to their concern.
- The first node must branch from the biggest concern question to different concern-specific paths.
- Add "if" branches to at least ${MIN_BRANCHING_NODES} different nodes when those nodes have answer_values_for_if.
- Prefer branching on the primary concern question, severity questions, subtype questions, duration questions, trigger questions, and sensitivity questions.
- Each branching node must include at least 2 answer mappings inside "if" when at least 2 answer_values_for_if exist.
- A branch should skip only questions made less relevant by that answer, or jump to a more relevant next question.
- Do not skip safety or purchase-fit questions about allergies, avoided ingredients, budget, or previous treatments unless the current question already covers that topic.
- The final reachable node must route to "END".
- Every question must still appear as a node, even if some branches skip it.
- Prefer default routing to the next_linear_question_id shown below.
- Each user path should usually contain 5 to 8 questions, not all stored questions.
- Different primary concerns should lead to visibly different follow-up paths.
- Common final questions such as allergies, previous treatments, routine habits, and budget may be shared by many paths before "END".
- If fewer than ${MIN_BRANCHING_NODES} questions have answer_values_for_if, add branches to every question that does have answer_values_for_if.

QUESTIONS AVAILABLE FOR ROUTING:
${JSON.stringify(buildFlowPromptQuestions(questions), null, 2)}

Return ONLY valid JSON. Do not include markdown.

Respond in this exact top-level shape:
{
  "flow_json": {
    "start": "${questions[0].question_id}",
    "nodes": {
      "${questions[0].question_id}": {
        "default": "${questions[1]?.question_id || 'END'}"
      }
    }
  }
}

The example above shows the object shape only. Your real response must include every generated question_id in nodes and must satisfy all branching rules.
`

      let flowJson = null

      try {
        const flowResult = await generateWithRetry(model, flowPrompt)
        const flowUsage = formatGeminiUsage(flowResult.response.usageMetadata)
        const flowResponse = await parseJsonResponseWithRepair(model, flowResult.response.text())
        flowJson = normaliseGeneratedFlow(extractFlowFromAi(flowResponse), questions)
        assertGeneratedDecisionTree(flowJson)
        aiUsage = {
          input_tokens: questionsUsage.input_tokens + flowUsage.input_tokens,
          output_tokens: questionsUsage.output_tokens + flowUsage.output_tokens,
          thinking_tokens: questionsUsage.thinking_tokens + flowUsage.thinking_tokens,
          other_tokens: questionsUsage.other_tokens + flowUsage.other_tokens,
          total_tokens: questionsUsage.total_tokens + flowUsage.total_tokens,
          cached_tokens: questionsUsage.cached_tokens + flowUsage.cached_tokens
        }
      } catch (flowError) {
        console.error('Gemini flow routing failed:', flowError.message)
        throw flowError
      }

      flow = {
        questions_json: questions,
        flow_json: flowJson
      }
    } catch (error) {
      console.error('Gemini flow generation failed. Using deterministic fallback flow:', error.message)
      flow = buildFallbackFlow(category, products)
      usedFallback = true
      fallbackReason = error.message
    }

    if (!Array.isArray(flow.questions_json) || !flow.flow_json) {
      console.error('AI did not return a valid question flow shape. Using deterministic fallback flow.')
      flow = buildFallbackFlow(category, products)
      aiUsage = emptyUsage
      usedFallback = true
      fallbackReason = fallbackReason || 'AI did not return a valid question flow shape.'
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
      fallback_reason: fallbackReason,
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


