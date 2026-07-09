const crypto = require('crypto')
const { GoogleGenerativeAI } = require('@google/generative-ai')
const supabase = require('../config/supabase')
const { formatGeminiUsage } = require('../utils/geminiUsage')
require('dotenv').config()

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

const getErrorMessage = error => {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string') return error
  if (typeof error?.message === 'string') return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return ''
  }
}

const isMissingColumnError = (error, table, column) => {
  const message = getErrorMessage(error)
  return (
    message.includes(`'${column}'`) &&
    message.includes(`'${table}'`) &&
    message.includes('schema cache')
  ) || (
    message.includes(`${table}.${column}`) &&
    message.includes('does not exist')
  ) || (
    message.includes(`column ${table}.${column} does not exist`)
  )
}

const isMissingProductsStoreIdError = error => (
  isMissingColumnError(error, 'products', 'store_id')
)

const isMissingQuestionFlowsStoreIdError = error => (
  isMissingColumnError(error, 'brand_question_flows', 'store_id')
)

const withoutStoreIdColumn = columns => String(columns || '*')
  .replace(/\bstore_id\s*,\s*/g, '')
  .replace(/,\s*store_id\b/g, '')
  .replace(/\bstore_id\b/g, '')

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

const combineUsage = (...usages) => usages.reduce((total, usage = emptyUsage) => ({
  input_tokens: total.input_tokens + (usage.input_tokens || 0),
  output_tokens: total.output_tokens + (usage.output_tokens || 0),
  thinking_tokens: total.thinking_tokens + (usage.thinking_tokens || 0),
  other_tokens: total.other_tokens + (usage.other_tokens || 0),
  total_tokens: total.total_tokens + (usage.total_tokens || 0),
  cached_tokens: total.cached_tokens + (usage.cached_tokens || 0)
}), { ...emptyUsage })

const GENERATED_QUESTION_COUNT = 14
const MIN_GENERATED_QUESTIONS = 12
const MIN_BRANCHING_NODES = 4
const GENERIC_CATALOG_SIGNAL_PATTERNS = [
  /^all$/i,
  /^shop all$/i,
  /^all collection$/i,
  /^hidden[_\s-]*product$/i,
  /^general$/i,
  /^taupe/i,
  /^mytaupe$/i,
  /prepaid/i,
  /discount/i,
  /combo/i,
  /kit/i,
  /sets?$/i,
  /party supplies/i,
  /collection/i,
  /^new$/i,
  /^best sellers?$/i,
  /^featured$/i,
  /^homepage$/i,
  /^sale$/i
]

const cleanCatalogSignal = value => {
  const signal = String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!signal || signal.length < 3) return null
  if (GENERIC_CATALOG_SIGNAL_PATTERNS.some(pattern => pattern.test(signal))) return null

  return signal
}

const uniqueCleanSignals = values => Array.from(new Set(
  values
    .map(cleanCatalogSignal)
    .filter(Boolean)
))

const categoryIncludes = (category, terms) => {
  const normalized = String(category || '').toLowerCase()
  return terms.some(term => normalized.includes(term))
}

const isProblemSolvingCategory = category =>
  categoryIncludes(category, [
    'skin',
    'beauty',
    'cosmetic',
    'hair',
    'scalp',
    'wellness',
    'supplement',
    'nutrition'
  ])

const isSkinCategory = category =>
  categoryIncludes(category, ['skin', 'beauty', 'cosmetic'])

const isHairCategory = category =>
  categoryIncludes(category, ['hair', 'scalp', 'shampoo'])

const categoryFallbackGoals = category => {
  if (categoryIncludes(category, ['skin', 'beauty', 'cosmetic'])) {
    return ['Hydration', 'Acne or breakouts', 'Oil control', 'Glow and dullness', 'Sensitivity', 'Anti-aging']
  }

  if (categoryIncludes(category, ['hair', 'scalp', 'shampoo'])) {
    return ['Hair fall', 'Dandruff or scalp care', 'Frizz control', 'Damage repair', 'Volume', 'Smooth styling']
  }

  if (categoryIncludes(category, ['supplement', 'wellness', 'nutrition'])) {
    return ['Energy support', 'Immunity', 'Sleep and stress', 'Hair or skin support', 'Joint health', 'Daily wellness']
  }

  if (categoryIncludes(category, ['accessor', 'fashion', 'apparel'])) {
    return ['Everyday style', 'Office or formal wear', 'Gift purchase', 'Premium look', 'Comfort fit', 'Best value']
  }

  if (categoryIncludes(category, ['electronic', 'gadget', 'device'])) {
    return ['Work or productivity', 'Entertainment', 'Travel use', 'Compatibility need', 'Premium features', 'Best value']
  }

  return ['Everyday use', 'Gift purchase', 'Premium option', 'Best value', 'Specific need', 'Not sure']
}

const categoryFallbackProfileOptions = category => {
  if (categoryIncludes(category, ['skin', 'beauty', 'cosmetic'])) {
    return ['Dry skin', 'Oily skin', 'Combination skin', 'Sensitive skin', 'Not sure']
  }

  if (categoryIncludes(category, ['hair', 'scalp', 'shampoo'])) {
    return ['Dry hair', 'Oily scalp', 'Frizzy hair', 'Damaged hair', 'Not sure']
  }

  return ['Minimal and practical', 'Premium-focused', 'Trend-led', 'Value-focused', 'Not sure']
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
// Builds a compact catalog-aware fallback flow when Gemini generation is unavailable.
const parseJsonColumn = (value, fallback) => {
  if (!value) return fallback
  if (typeof value !== 'string') return value

  try {
    return JSON.parse(value)
  } catch (error) {
    return fallback
  }
}

const normalizeQuestionCategory = value => String(value || 'general')
  .trim()
  .toLowerCase()
  .replace(/[_-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .slice(0, 80)

const categoryCandidates = category => Array.from(new Set([
  category,
  normalizeQuestionCategory(category)
].filter(Boolean)))

const getActiveFlowQuestions = async (brandId, category, storeId = null) => {
  const flow = await getActiveFlowRow(brandId, category, storeId, 'questions_json')
  const questionsJson = parseJsonColumn(flow?.questions_json, [])
  const questions = Array.isArray(questionsJson)
    ? questionsJson
    : questionsJson.questions || []

  return questions.map((question, index) => ({
    ...question,
    question_id: question.question_id || question.id || `dynamic_${index + 1}`,
    field_key: question.field_key || question.question_id || question.id || `dynamic_${index + 1}`,
    category: question.category || category,
    section_label: question.section_label || 'Assessment'
  }))
}

const getActiveFlowRow = async (brandId, category, storeId = null, columns = '*', options = {}) => {
  const fetchFlow = async (scopedStoreId, scopedCategory, allowStoreFallback = true) => {
    let query = supabase
      .from('brand_question_flows')
      .select(columns)
      .eq('brand_id', brandId)
      .eq('is_active', true)

    if (scopedCategory) query = query.eq('category', scopedCategory)

    query = scopedStoreId
      ? query.eq('store_id', scopedStoreId)
      : query.is('store_id', null)

    const { data, error } = await query
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (allowStoreFallback && isMissingQuestionFlowsStoreIdError(error)) {
      let fallbackQuery = supabase
        .from('brand_question_flows')
        .select(withoutStoreIdColumn(columns))
        .eq('brand_id', brandId)
        .eq('is_active', true)

      if (scopedCategory) fallbackQuery = fallbackQuery.eq('category', scopedCategory)

      const fallback = await fallbackQuery
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (fallback.error) throw fallback.error
      return fallback.data ? { ...fallback.data, store_id: null } : fallback.data
    }

    if (error) throw error
    return data
  }

  for (const candidateCategory of categoryCandidates(category)) {
    if (storeId) {
      const storeFlow = await fetchFlow(storeId, candidateCategory)
      if (storeFlow) return storeFlow
    }

    const brandFlow = await fetchFlow(null, candidateCategory)
    if (brandFlow) return brandFlow
  }

  if (options.fallbackAnyCategory) {
    if (storeId) {
      const storeFlow = await fetchFlow(storeId, null)
      if (storeFlow) return storeFlow
    }

    return fetchFlow(null, null)
  }

  return null
}

const compactText = (value, maxLength = 160) => String(value || '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maxLength)

const rotateArray = (values, seed = 0) => {
  if (!values.length) return values
  const offset = Math.abs(seed) % values.length
  return [...values.slice(offset), ...values.slice(0, offset)]
}

const hashText = value => crypto
  .createHash('sha1')
  .update(String(value || ''))
  .digest('hex')

const buildCatalogProfile = (products, catalogueSignals) => {
  const prices = products
    .map(product => Number(product.price))
    .filter(price => Number.isFinite(price) && price > 0)

  return {
    product_count: products.length,
    categories: uniqueCleanSignals(products.map(product => product.category)).slice(0, 8),
    vendors: uniqueCleanSignals(products.map(product => product.vendor)).slice(0, 6),
    common_product_signals: catalogueSignals.slice(0, 16),
    price_range: prices.length
      ? { min: Math.min(...prices), max: Math.max(...prices) }
      : null,
    product_examples: products.slice(0, 12).map(product => ({
      name: product.name,
      category: cleanCatalogSignal(product.category) || product.category,
      price: product.price,
      tags: uniqueCleanSignals([
        ...(product.product_tags || []),
        ...(product.suitable_customer_attributes || []),
        ...((product.product_match_tags || []).map(tag => tag.match_tag))
      ]).slice(0, 6),
      description: compactText(product.description, 140)
    }))
  }
}

const buildFallbackFlow = (category, products, seed = 0) => {
  if (isSkinCategory(category)) {
    const questions_json = [
      { question_id: 'q1', field_key: 'primary_concern', question_text: 'What skin concern do you want to improve first?', sub_text: 'Pick the issue you want the routine to focus on.', input_type: 'chips', options_json: ['Acne or breakouts', 'Tan or pigmentation', 'Blackheads or clogged pores', 'Dullness or uneven glow', 'Dryness or dehydration', 'Sensitivity or irritation'], category, section_label: 'Assessment' },
      { question_id: 'q2', field_key: 'skin_type', question_text: 'How does your skin usually feel during the day?', sub_text: 'This helps us choose products that suit your skin behavior.', input_type: 'cards', options_json: [{ label: 'Oily', emoji: '', sub: 'Gets shiny or greasy' }, { label: 'Dry', emoji: '', sub: 'Feels tight or flaky' }, { label: 'Combination', emoji: '', sub: 'Oily T-zone, dry cheeks' }, { label: 'Sensitive', emoji: '', sub: 'Reacts easily' }, { label: 'Not sure', emoji: '', sub: 'Need guidance' }], category, section_label: 'Assessment' },
      { question_id: 'q3', field_key: 'concern_severity', question_text: 'How intense is this concern right now?', sub_text: 'Use 1 for mild and 5 for severe.', input_type: 'scale', options_json: [1, 2, 3, 4, 5], category, section_label: 'Assessment' },
      { question_id: 'q4', field_key: 'concern_duration', question_text: 'How long have you noticed this concern?', sub_text: 'Duration helps us keep the recommendation realistic.', input_type: 'chips', options_json: ['Less than 2 weeks', '2-6 weeks', '2-6 months', 'More than 6 months', 'It comes and goes'], category, section_label: 'Assessment' },
      { question_id: 'q5', field_key: 'current_routine', question_text: 'What do you currently use on your skin?', sub_text: 'Mention cleanser, mask, moisturizer, sunscreen, or treatments.', input_type: 'text', options_json: { placeholder: 'Example: face wash daily, mask once a week, no sunscreen...' }, category, section_label: 'Assessment' },
      { question_id: 'q6', field_key: 'triggers', question_text: 'What seems to trigger or worsen it?', sub_text: 'Choose what applies most often.', input_type: 'chips', options_json: ['Sun exposure', 'Sweat or pollution', 'Stress or sleep', 'New products', 'Periods or hormones', 'Not sure'], category, section_label: 'Assessment' },
      { question_id: 'q7', field_key: 'allergies', question_text: 'Any ingredients or product types your skin reacts to?', sub_text: 'This helps us avoid poor-fit recommendations.', input_type: 'text', options_json: { placeholder: 'Write none if there are no known reactions' }, category, section_label: 'Assessment' },
      { question_id: 'q8', field_key: 'budget', question_text: 'What budget range should we stay within?', sub_text: 'We will keep the routine practical.', input_type: 'chips', options_json: ['Under 500', '500-1000', '1000-2000', 'No strict budget'], category, section_label: 'Assessment' }
    ]

    return {
      questions_json,
      flow_json: buildLinearFlow(questions_json),
      advisor_config: {
        requires_photo: false,
        photo_reason: 'skin concern analysis',
        requires_routine: true,
        recommendation_style: 'routine'
      },
      recommendation_schema: {
        primary_concern_weight: 0.35,
        profile_weight: 0.2,
        photo_weight: 0.25,
        budget_weight: 0.2
      }
    }
  }

  if (isHairCategory(category)) {
    const questions_json = [
      { question_id: 'q1', field_key: 'primary_concern', question_text: 'What hair or scalp problem do you want to improve first?', sub_text: 'Pick the issue the routine should focus on.', input_type: 'chips', options_json: ['Hair fall', 'Dandruff or flakes', 'Dry or itchy scalp', 'Frizz', 'Damage or breakage', 'Low volume'], category, section_label: 'Assessment' },
      { question_id: 'q2', field_key: 'hair_type', question_text: 'Which best describes your hair or scalp?', sub_text: 'This helps us choose the right product type.', input_type: 'cards', options_json: [{ label: 'Oily scalp', emoji: '', sub: '' }, { label: 'Dry scalp', emoji: '', sub: '' }, { label: 'Curly or wavy', emoji: '', sub: '' }, { label: 'Chemically treated', emoji: '', sub: '' }, { label: 'Not sure', emoji: '', sub: '' }], category, section_label: 'Assessment' },
      { question_id: 'q3', field_key: 'concern_severity', question_text: 'How intense is this concern right now?', sub_text: 'Use 1 for mild and 5 for severe.', input_type: 'scale', options_json: [1, 2, 3, 4, 5], category, section_label: 'Assessment' },
      { question_id: 'q4', field_key: 'wash_frequency', question_text: 'How often do you wash your hair?', sub_text: 'Routine frequency changes product recommendations.', input_type: 'chips', options_json: ['Daily', '2-3 times a week', 'Once a week', 'Less than once a week'], category, section_label: 'Assessment' },
      { question_id: 'q5', field_key: 'current_routine', question_text: 'What hair products are you using now?', sub_text: 'Mention shampoo, oil, serum, mask, or treatments.', input_type: 'text', options_json: { placeholder: 'Example: anti-dandruff shampoo, hair oil weekly...' }, category, section_label: 'Assessment' },
      { question_id: 'q6', field_key: 'triggers', question_text: 'What seems to worsen the problem?', sub_text: 'Choose what applies most often.', input_type: 'chips', options_json: ['Heat styling', 'Sweat or pollution', 'Stress', 'Coloring or chemicals', 'Weather change', 'Not sure'], category, section_label: 'Assessment' },
      { question_id: 'q7', field_key: 'allergies', question_text: 'Any ingredients or product types you avoid?', sub_text: 'This helps us avoid poor-fit recommendations.', input_type: 'text', options_json: { placeholder: 'Write none if there are no restrictions' }, category, section_label: 'Assessment' },
      { question_id: 'q8', field_key: 'budget', question_text: 'What budget range should we stay within?', sub_text: 'We will keep the routine practical.', input_type: 'chips', options_json: ['Under 500', '500-1000', '1000-2000', 'No strict budget'], category, section_label: 'Assessment' }
    ]

    return {
      questions_json,
      flow_json: buildLinearFlow(questions_json),
      advisor_config: {
        requires_photo: false,
        photo_reason: null,
        requires_routine: true,
        recommendation_style: 'routine'
      },
      recommendation_schema: {
        primary_concern_weight: 0.4,
        profile_weight: 0.25,
        budget_weight: 0.2,
        routine_weight: 0.15
      }
    }
  }

  const concernSet = new Set()
  const typeSet = new Set()

  products.forEach(product => {
    uniqueCleanSignals([
      product.category,
      ...(product.product_tags || []),
      ...(product.product_match_tags || []).map(tag => tag.match_tag)
    ]).forEach(signal => concernSet.add(signal))

    uniqueCleanSignals(product.suitable_customer_attributes || [])
      .forEach(type => typeSet.add(type))
  })

  const concernOptions = rotateArray(Array.from(concernSet), seed).slice(0, 8)
  const typeOptions = rotateArray(Array.from(typeSet), seed + 1).slice(0, 6)
  const concerns = concernOptions.length >= 4 ? concernOptions : categoryFallbackGoals(category)
  const types = typeOptions.length >= 3 ? typeOptions : categoryFallbackProfileOptions(category)
  const priorityOptions = rotateArray([
    'Best match for my need',
    'Style or look',
    'Comfort or ease of use',
    'Durability or long life',
    'Premium feel',
    'Best value'
  ], seed + 2)

  const questions_json = [
    { question_id: 'q1', field_key: 'primary_concern', question_text: `What do you want help choosing from this ${category} catalog?`, sub_text: 'Choose the closest goal so we can narrow the products.', input_type: 'chips', options_json: concerns, category, section_label: 'Assessment' },
    { question_id: 'q2', field_key: 'profile_type', question_text: 'Which option describes your buying style best?', sub_text: 'This helps us match products to your taste and confidence level.', input_type: 'cards', options_json: types.map(type => ({ label: type, emoji: '', sub: '' })), category, section_label: 'Assessment' },
    { question_id: 'q3', field_key: 'priority_level', question_text: 'How important is getting the perfect match?', sub_text: 'Use 1 for flexible and 5 for very specific.', input_type: 'scale', options_json: [1, 2, 3, 4, 5], category, section_label: 'Assessment' },
    { question_id: 'q4', field_key: 'purchase_timing', question_text: 'When do you plan to use or gift it?', sub_text: 'A rough timing helps us choose practical options.', input_type: 'chips', options_json: ['Immediately', 'This week', 'This month', 'Just exploring'], category, section_label: 'Assessment' },
    { question_id: 'q5', field_key: 'selection_priority', question_text: 'What matters most in your final choice?', sub_text: 'Pick the strongest deciding factor.', input_type: 'chips', options_json: priorityOptions, category, section_label: 'Assessment' },
    { question_id: 'q6', field_key: 'previous_products', question_text: 'Have you bought something similar before?', sub_text: 'Mention what you liked or did not like.', input_type: 'text', options_json: { placeholder: 'Example: product names, styles, or what worked/did not work...' }, category, section_label: 'Assessment' },
    { question_id: 'q7', field_key: 'allergies', question_text: 'Any materials, ingredients, or styles you avoid?', sub_text: 'This helps us filter poor-fit recommendations.', input_type: 'text', options_json: { placeholder: 'Write none if there are no restrictions' }, category, section_label: 'Assessment' },
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

const assertCategoryQuestionIntent = (questions, category) => {
  if (!isProblemSolvingCategory(category)) return

  const forbiddenOptionPattern = /\b(mask|face wash|cleanser|combo|kit|set|discount|prepaid|collection|gift|party|premium feel|style|look)\b/i
  const primaryConcernOptions = optionLabels(questions[0])
  const badOptions = primaryConcernOptions.filter(option => forbiddenOptionPattern.test(option))

  if (badOptions.length) {
    throw new Error(`Problem-solving categories must ask concerns, not catalog labels. Bad q1 options: ${badOptions.join(', ')}`)
  }

  const questionText = questions
    .slice(0, 6)
    .map(question => `${question.question_text || ''} ${question.field_key || ''}`)
    .join(' ')
    .toLowerCase()

  const problemSignals = ['concern', 'problem', 'severity', 'duration', 'trigger', 'skin type', 'hair type', 'scalp', 'routine', 'allerg']
  const hasProblemAssessment = problemSignals.some(signal => questionText.includes(signal))

  if (!hasProblemAssessment) {
    throw new Error('Problem-solving category question bank is missing concern/severity/routine assessment questions.')
  }
}

const assertGeneratedDecisionTree = flowJson => {
  const branchCount = countBranchingNodes(flowJson)
  if (branchCount < MIN_BRANCHING_NODES) {
    throw new Error(`Gemini returned only ${branchCount} branching nodes; expected at least ${MIN_BRANCHING_NODES}.`)
  }

  const firstNode = flowJson.nodes?.q1
  if (!firstNode?.if || Object.keys(firstNode.if).length < 3) {
    throw new Error('Gemini q1 must branch to at least 3 product-selection paths.')
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

    const data = await getActiveFlowRow(
      req.brand.brand_id,
      category,
      req.shopifyStore?.id,
      'flow_id, brand_id, store_id, category, version, questions_json, flow_json, is_active, updated_at',
      { fallbackAnyCategory: true }
    )

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
const generateQuestionFlowForBrand = async (brand, requestedCategory, options = {}) => {
    const category = requestedCategory || brand.product_category || 'general'
    const brandId = brand.brand_id
    const storeId = options.storeId || null
    const generationSeed = Number.parseInt(hashText(`${storeId || brandId}:${category}:${Date.now()}`).slice(0, 8), 16)

    let productsQuery = supabase
      .from('products')
      .select(`
        name,
        category,
        description,
        price,
        vendor,
        product_tags,
        suitable_customer_attributes,
        product_components(name),
        product_match_tags(match_tag, intensity_level, priority_score)
      `)
      .eq('brand_id', brandId)
      .eq('is_active', true)

    if (storeId) productsQuery = productsQuery.eq('store_id', storeId)

    let { data: products, error: productsError } = await productsQuery

    if (isMissingProductsStoreIdError(productsError)) {
      const fallback = await supabase
        .from('products')
        .select(`
          name,
          category,
          description,
          price,
          vendor,
          product_tags,
          suitable_customer_attributes,
          product_components(name),
          product_match_tags(match_tag, intensity_level, priority_score)
        `)
        .eq('brand_id', brandId)
        .eq('is_active', true)

      products = fallback.data
      productsError = fallback.error
    }

    if (productsError) throw productsError
    if (!products || products.length === 0) {
      const error = new Error('No active products found for this brand.')
      error.statusCode = 404
      throw error
    }

    const productContext = rotateArray(products, generationSeed).slice(0, 12).map(product => ({
      name: product.name,
      category: cleanCatalogSignal(product.category) || product.category,
      price: product.price,
      vendor: cleanCatalogSignal(product.vendor) || product.vendor,
      product_tags: uniqueCleanSignals(product.product_tags || []),
      description: compactText(product.description, 140),
      suitable_customer_attributes: uniqueCleanSignals(product.suitable_customer_attributes || []).slice(0, 6),
      match_tags: uniqueCleanSignals((product.product_match_tags || []).map(tag => tag.match_tag)).slice(0, 6)
    }))
    const catalogueSignals = Array.from(new Set(
      products.flatMap(product => [
        product.category,
        ...(product.product_tags || []),
        ...(product.suitable_customer_attributes || []),
        ...(product.product_match_tags || []).map(tag => tag.match_tag)
      ])
        .map(cleanCatalogSignal)
        .filter(Boolean)
    )).slice(0, 16)
const catalogProfile = buildCatalogProfile(
  products,
  catalogueSignals
)

let previousFlowsQuery = supabase
  .from('brand_question_flows')
  .select('questions_json')
  .eq('brand_id', brandId)
  .eq('category', category)

if (storeId) previousFlowsQuery = previousFlowsQuery.eq('store_id', storeId)
else previousFlowsQuery = previousFlowsQuery.is('store_id', null)

let { data: previousFlows, error: previousFlowsError } = await previousFlowsQuery
  .order('version', {
    ascending: false
  })
  .limit(3)

if (isMissingQuestionFlowsStoreIdError(previousFlowsError)) {
  const fallback = await supabase
    .from('brand_question_flows')
    .select('questions_json')
    .eq('brand_id', brandId)
    .eq('category', category)
    .order('version', { ascending: false })
    .limit(3)

  previousFlows = fallback.data
  previousFlowsError = fallback.error
}

if (previousFlowsError) throw previousFlowsError

const previousQuestions =
  (previousFlows || [])
    .flatMap(flow => flow.questions_json || [])
    .map(q => q.question_text)

const questionStyles = [
  'direct',
  'conversational',
  'scenario',
  'preference',
  'problem_based'
]

const questionStyle =
  questionStyles[
    generationSeed %
    questionStyles.length
  ]

const questionSequenceStyles = [
  'concern_first',
  'profile_first',
  'lifestyle_first',
  'goal_first'
]

const questionSequence =
  questionSequenceStyles[
    generationSeed %
    questionSequenceStyles.length
  ]

const generationGuidance = {
  seed: generationSeed,
  question_style: questionStyle,
  question_sequence: questionSequence,
  instruction: `
Use this seed to create a fresh advisor experience.

You may vary:
- question wording
- conversational style
- question framing
- option ordering
- question sequence
- shopper persona
- follow-up path emphasis

Do NOT change:
- product facts
- catalog signals
- match tags
- recommendation logic

Each regeneration should feel like a newly designed advisor while remaining grounded in the product catalog.
`
}

const brandSummaryPrompt = `
Understand this product catalog before generating quiz questions.

BRAND:
${brand.name}

CATEGORY:
${category}

PRODUCT PROFILE:
${JSON.stringify({
  product_count:
    catalogProfile.product_count,
  categories:
    catalogProfile.categories,
  common_product_signals:
    catalogProfile.common_product_signals
})}

CATALOG SIGNALS:
${JSON.stringify(
  catalogueSignals.slice(0, 15)
)}

TASK:

Identify:

1. What this brand sells.
2. Main product families.
3. What differentiates one SKU from another.
4. Shopper goals that matter.
5. Information that should be collected later in the quiz.

RULES:

- Use only the catalog information provided.
- Do not invent products, ingredients, materials, benefits, sizes, compatibility, or customer types.
- Focus only on differences that can affect recommendations.
- Keep the summary practical for question generation.
- Maximum:
  • 6 shopper goals
  • 6 must-ask contexts
  • 5 avoid-asking items.

Return ONLY JSON:

{
  "brand_summary": {
    "brand_name": "${brand.name}",
    "inferred_category": "",
    "catalog_summary": "",
    "primary_product_families": [],
    "important_sku_differences": [],
    "likely_shopper_goals": [],
    "must_ask_context": [],
    "avoid_asking": []
  }
}
`

 const questionPlanPrompt = brandSummary => `
Decide the best shopper dimensions for a product-advisor quiz.

CATEGORY:
${category}

BRAND SUMMARY:
${JSON.stringify({
  inferred_category:
    brandSummary.inferred_category,
  primary_product_families:
    brandSummary.primary_product_families,
  important_sku_differences:
    brandSummary.important_sku_differences,
  likely_shopper_goals:
    brandSummary.likely_shopper_goals,
  must_ask_context:
    brandSummary.must_ask_context
})}

CATALOG SIGNALS:
${JSON.stringify(
  catalogueSignals.slice(0, 15)
)}

GENERATION:
${JSON.stringify({
  style:
    generationGuidance.question_style,
  sequence:
    generationGuidance.question_sequence
})}

CATEGORY HINTS:

skincare:
skin_type, concern, sensitivity,
ingredient_avoidance, routine.
For skincare, q1 must ask the skin problem/concern, not the product family.
Good q1 options: acne, tan/pigmentation, blackheads, dullness, dryness, sensitivity.
Bad q1 options: masks, face wash, combos, kits, discounts, collection names.

haircare:
hair_type, scalp_condition,
goal, wash_frequency.
For haircare, q1 must ask the hair/scalp problem, not the product family.
Good q1 options: hair fall, dandruff, itchy scalp, frizz, damage, low volume.

accessories:
occasion, style, material,
size, gifting, color pairing.

electronics:
use_case, compatibility,
features, portability, budget.

supplements:
goal, restrictions,
format, sensitivities.

RULES:

1. Choose dimensions that distinguish
actual SKUs.

2. For skincare, haircare, wellness, supplements, or any category that cures/supports a problem:
- ask the consumer's problem, severity, duration, triggers, restrictions, current routine, and budget.
- do not ask buying style, taste, occasion, gifting, premium feel, or style unless the catalog is actually fashion/accessories.

3. Do not force skincare dimensions
onto non-skincare categories.

4. Ask about allergies/materials
only when relevant.

5. Prefer shopper language.

6. Avoid dimensions that would not
change recommendations.

7. Include dimensions that can later
be mapped to product tags or
match tags.

Return ONLY JSON:

{
  "question_plan": {
    "generation_category": "",
    "category_reasoning": "",
    "primary_goal_options": [],
    "question_dimensions": [
      {
        "dimension": "",
        "why_it_matters": "",
        "example_answer_options": []
      }
    ],
    "shared_final_dimensions": [],
    "avoid_questions_about": []
  }
}
`

   const buildQuestionsPrompt = (
  brandSummary,
  questionPlan
) => `
Generate a reusable product-advisor quiz for ${brand.name}.

CATEGORY:
${category}

BRAND SUMMARY:
${JSON.stringify({
  inferred_category:
    brandSummary.inferred_category,
  primary_product_families:
    brandSummary.primary_product_families,
  important_sku_differences:
    brandSummary.important_sku_differences,
  likely_shopper_goals:
    brandSummary.likely_shopper_goals
})}

QUESTION PLAN:
${JSON.stringify({
  generation_category:
    questionPlan.generation_category,
  question_dimensions:
    questionPlan.question_dimensions,
  shared_final_dimensions:
    questionPlan.shared_final_dimensions
})}

CATALOG SIGNALS:
${JSON.stringify(
  catalogueSignals.slice(0, 15)
)}

PRODUCT EXAMPLES:
${JSON.stringify(
  productContext.slice(0, 8)
)}

PREVIOUS QUESTIONS:
${JSON.stringify(
  previousQuestions.slice(-10)
)}

GENERATION:
${JSON.stringify({
  style:
    generationGuidance.question_style,
  sequence:
    generationGuidance.question_sequence,
  seed:
    generationGuidance.seed
})}

TASK:
Create a routed question bank that helps shoppers choose products from this catalog.

IMPORTANT CATEGORY BEHAVIOR:
If CATEGORY is skincare, haircare, wellness, supplements, or any problem-solving product category:
- The quiz must behave like a problem assessment, not a shopping preference survey.
- Ask what problem the consumer wants to solve, how severe it is, how long it has been happening, what triggers it, current routine, allergies/restrictions, lifestyle context, and budget.
- Never use Shopify collection labels, product types, discount tags, bundles, kit names, or product family names as primary concern options.
- Do not ask "buying style", "perfect match", "premium feel", "style or look", "occasion", or "gift" unless the category is fashion/accessories/gifts.

RULES:

1. Generate exactly ${GENERATED_QUESTION_COUNT} questions.

2. q1:
- field_key: primary_concern
- ask the primary concern/problem for problem-solving categories
- ask buying goal, occasion, style, or use case only for non-problem categories
- minimum 4 options

3. q2-q10:
- category-specific follow-up questions
- questions must help distinguish SKUs
- questions must vary according to catalog signals

4. q11-q${GENERATED_QUESTION_COUNT}:
- shared purchase-fit questions:
budget, constraints, gifting, compatibility, preferences, previous experience.

5. Questions should:
- be concise
- consumer friendly
- avoid Shopify labels
- avoid generic questions
- avoid repeating product names

6. Do NOT repeat wording from PREVIOUS QUESTIONS.

You may ask the same dimension but vary:
- wording
- framing
- option order
- sequence
- conversational style

7. Follow:
Style:
${generationGuidance.question_style}

Sequence:
${generationGuidance.question_sequence}

8. Same catalog synced multiple times must produce a fresh advisor experience.

OUTPUT:

{
  "questions_json": [
    {
      "question_id":"q1",
      "field_key":"primary_concern",
      "question_text":"...",
      "sub_text":"...",
      "input_type":"chips",
      "options_json":["..."],
      "category":"${category}",
      "section_label":"Assessment"
    }
  ]
}

Return ONLY valid JSON.
`

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.85,
        topP: 0.95,
        maxOutputTokens: 4500
      }
    })
    let aiUsage = emptyUsage
    let flow
    let usedFallback = false
    let fallbackReason = null

    try {
      const summaryResult = await generateWithRetry(model, brandSummaryPrompt)
      const summaryUsage = formatGeminiUsage(summaryResult.response.usageMetadata)
      const summaryResponse = await parseJsonResponseWithRepair(model, summaryResult.response.text())
      const brandSummary = summaryResponse.brand_summary || summaryResponse

      const planResult = await generateWithRetry(model, questionPlanPrompt(brandSummary))
      const planUsage = formatGeminiUsage(planResult.response.usageMetadata)
      const planResponse = await parseJsonResponseWithRepair(model, planResult.response.text())
      const questionPlan = planResponse.question_plan || planResponse

      const questionsPrompt = buildQuestionsPrompt(brandSummary, questionPlan)
      let questionsResult = await generateWithRetry(model, questionsPrompt)
      let questionsUsage = formatGeminiUsage(questionsResult.response.usageMetadata)
      let questionsResponse = await parseJsonResponseWithRepair(model, questionsResult.response.text())
      let questions = normaliseGeneratedQuestions(extractQuestionsFromAi(questionsResponse), category)

      if (!questions.length) {
        throw new Error('Gemini did not return usable questions.')
      }

      try {
        assertGeneratedQuestionBank(questions)
        assertCategoryQuestionIntent(questions, category)
      } catch (qualityError) {
        const retryPrompt = `
Your previous response was not acceptable: ${qualityError.message}

Regenerate the complete question bank now.

Rules:
- Return ONLY valid JSON.
- Top-level key must be "questions_json".
- questions_json must contain exactly ${GENERATED_QUESTION_COUNT} complete question objects.
- Use question_id values q1 through q${GENERATED_QUESTION_COUNT} with no gaps.
- q1 field_key must be "primary_concern".
- For skincare, haircare, wellness, supplements, or problem-solving categories, q1 must ask the consumer's problem/concern, not product family or buying style.
- q1 must have at least 4 useful concern/problem options.
- q2-q10 must be category-specific product-selection follow-up questions grounded in the catalog.
- q11-q14 must be shared final fit questions. For problem-solving categories use budget, allergies/restrictions, current routine, previous products tried, lifestyle, or usage habits.
- Do not use Shopify labels, discount tags, collection names, combos, kits, sets, or product types as concern options.
- Do not ask buying style, perfect match, premium feel, style/look, occasion, or gifting unless this is a fashion/accessory/gift category.
- Use only input_type: "chips", "cards", "scale", "text".
- Do not include markdown or explanations.

        BRAND CATEGORY: ${category}
        CATALOG SIGNALS: ${JSON.stringify(catalogueSignals)}
        COMPACT CATALOG PROFILE: ${JSON.stringify(catalogProfile)}
        GENERATION GUIDANCE: ${JSON.stringify(generationGuidance)}
        BRAND SUMMARY: ${JSON.stringify(brandSummary)}
        QUESTION PLAN: ${JSON.stringify(questionPlan)}
`

        questionsResult = await generateWithRetry(model, retryPrompt, 2)
        const retryUsage = formatGeminiUsage(questionsResult.response.usageMetadata)
        questionsUsage = combineUsage(questionsUsage, retryUsage)
        questionsResponse = await parseJsonResponseWithRepair(model, questionsResult.response.text())
        questions = normaliseGeneratedQuestions(extractQuestionsFromAi(questionsResponse), category)
        assertGeneratedQuestionBank(questions)
        assertCategoryQuestionIntent(questions, category)
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
- Create an actual decision tree where a user answers only the questions relevant to their shopping goal or requirement.
- The first node must branch from the primary buying goal question to different product-selection paths.
- Add "if" branches to at least ${MIN_BRANCHING_NODES} different nodes when those nodes have answer_values_for_if.
- Prefer branching on the primary buying goal, product family, occasion/use case, style preference, compatibility/size, budget, and important constraints.
- Each branching node must include at least 2 answer mappings inside "if" when at least 2 answer_values_for_if exist.
- A branch should skip only questions made less relevant by that answer, or jump to a more relevant next question.
- Do not skip safety or purchase-fit questions about allergies, avoided ingredients, budget, or previous treatments unless the current question already covers that topic.
- The final reachable node must route to "END".
- Every question must still appear as a node, even if some branches skip it.
- Prefer default routing to the next_linear_question_id shown below.
- Each user path should usually contain 5 to 8 questions, not all stored questions.
- Different primary buying goals should lead to visibly different follow-up paths.
- Common final questions such as budget, gifting/self-use, avoided materials/ingredients, sizing/compatibility, routine habits, or previous products may be shared by many paths before "END".
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
        aiUsage = combineUsage(summaryUsage, planUsage, questionsUsage, flowUsage)
      } catch (flowError) {
        console.error('Gemini flow routing failed:', flowError.message)
        throw flowError
      }
      const advisorPrompt = `
You are designing the recommendation engine configuration.

BRAND CATEGORY:
${category}

BRAND SUMMARY:
${JSON.stringify(brandSummary, null, 2)}

QUESTION PLAN:
${JSON.stringify(questionPlan, null, 2)}

PRODUCT CATALOG:
${JSON.stringify(catalogProfile, null, 2)}

Your task:

1. Decide whether recommendations can use optional photo analysis.

Examples:
- skincare → optional
- makeup → optional
- accessories → optional
- eyewear → optional
- supplements → no
- electronics → no

2. Decide whether recommendations need routines.

Examples:
- skincare → yes
- haircare → yes
- supplements → sometimes
- accessories → no
- electronics → no

3. Decide recommendation style.

Possible values:

"routine"
"products"

4. Create recommendation weights.

Weights must total 1.

Return ONLY JSON:

{
  "advisor_config": {
    "requires_photo": false,
    "photo_reason": "skin analysis",
    "requires_routine": true,
    "recommendation_style": "routine"
  },
  "recommendation_schema": {
    "primary_concern_weight": 0.35,
    "profile_weight": 0.25,
    "photo_weight": 0.25,
    "budget_weight": 0.15
  }
}
`
      const advisorResult = await generateWithRetry(model, advisorPrompt)
      const advisorUsage = formatGeminiUsage(advisorResult.response.usageMetadata)
      const advisorResponse = await parseJsonResponseWithRepair(model, advisorResult.response.text())
      aiUsage = combineUsage(aiUsage, advisorUsage)

      flow = {
        questions_json: questions,
        flow_json: flowJson,
        advisor_config: advisorResponse.advisor_config || {
          requires_photo: false,
          photo_reason: null,
          requires_routine: false,
          recommendation_style: 'products'
        },
        recommendation_schema: advisorResponse.recommendation_schema || {}
      }
    } catch (error) {
      console.error('Gemini flow generation failed. Using catalog fallback flow:', error.message)
      flow = buildFallbackFlow(category, products, generationSeed)
      usedFallback = true
      fallbackReason = error.message
    }

    if (!Array.isArray(flow.questions_json) || !flow.flow_json) {
      console.error('AI did not return a valid question flow shape. Using catalog fallback flow.')
      flow = buildFallbackFlow(category, products, generationSeed)
      aiUsage = emptyUsage
      usedFallback = true
      fallbackReason = fallbackReason || 'AI did not return a valid question flow shape.'
    }

    let latestFlowQuery = supabase
      .from('brand_question_flows')
      .select('version')
      .eq('brand_id', brandId)
      .eq('category', category)

    if (storeId) latestFlowQuery = latestFlowQuery.eq('store_id', storeId)
    else latestFlowQuery = latestFlowQuery.is('store_id', null)

    let { data: latestFlow, error: latestError } = await latestFlowQuery
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()

    const questionFlowsHaveStoreId = !isMissingQuestionFlowsStoreIdError(latestError)

    if (!questionFlowsHaveStoreId) {
      const fallback = await supabase
        .from('brand_question_flows')
        .select('version')
        .eq('brand_id', brandId)
        .eq('category', category)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle()

      latestFlow = fallback.data
      latestError = fallback.error
    }

    if (latestError) throw latestError

    const nextVersion = (latestFlow?.version || 0) + 1
    let deactivateQuery = supabase
      .from('brand_question_flows')
      .update({ is_active: false })
      .eq('brand_id', brandId)
      .eq('category', category)
      .eq('is_active', true)

    if (questionFlowsHaveStoreId) {
      if (storeId) deactivateQuery = deactivateQuery.eq('store_id', storeId)
      else deactivateQuery = deactivateQuery.is('store_id', null)
    }

    const { error: deactivateError } = await deactivateQuery

    if (deactivateError) throw deactivateError

    const flowPayload = {
      brand_id: brandId,
      category,
      version: nextVersion,
      questions_json: flow.questions_json,
      flow_json: flow.flow_json,
      advisor_config: flow.advisor_config,
      recommendation_schema: flow.recommendation_schema,
      is_active: true
    }

    if (questionFlowsHaveStoreId) flowPayload.store_id = storeId

    const selectColumns = questionFlowsHaveStoreId
      ? 'flow_id, brand_id, store_id, category, version, is_active, updated_at'
      : 'flow_id, brand_id, category, version, is_active, updated_at'

    const { data: savedFlow, error: saveError } = await supabase
      .from('brand_question_flows')
      .insert(flowPayload)
      .select(selectColumns)
      .single()

    if (saveError) throw saveError

    return {
      success: true,
      flow: savedFlow,
      fallback_used: usedFallback,
      fallback_reason: fallbackReason,
      ai_usage: aiUsage
    }
}

const generateQuestionFlow = async (req, res) => {
  try {
    const category = req.body.category || req.body.brand_category || req.shopifyStore?.product_category || req.brand.product_category || 'general'
    const result = await generateQuestionFlowForBrand(req.brand, category, { storeId: req.shopifyStore?.id })
    res.json(result)
  } catch (error) {
    console.error('Generate question flow error:', error)
    res.status(error.statusCode || 500).json({ error: error.message })
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
      let flowQuestions = await getActiveFlowQuestions(req.brand.brand_id, brand_category, req.shopifyStore?.id)

      if (!flowQuestions.length) {
        await generateQuestionFlowForBrand(req.brand, brand_category, { storeId: req.shopifyStore?.id })
        flowQuestions = await getActiveFlowQuestions(req.brand.brand_id, brand_category, req.shopifyStore?.id)
      }

      if (flowQuestions.length) {
        return res.json(buildQuestionResponse(
          brand_category,
          flowQuestions,
          flowQuestions.slice(0, 5).map(question => question.question_id),
          {},
          emptyUsage
        ))
      }

      return res.status(404).json({
        success: false,
        error: `No questions found for category: ${brand_category}`
      })
    }

    // Step 2 — build prompt for Gemini
    const prompt = `
You are an expert product advisor.

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
- If age is relevant to this brand category, use it to choose age-appropriate follow-up questions.
- Prioritise questions that match the stated brand category, product catalogue, and consumer goals.
- Avoid redundant questions — pick diverse questions that cover different angles
- Always include the primary product-selection question for the category

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

module.exports = { getFixedQuestions, getActiveQuestionFlow, generateQuestionFlow, generateQuestionFlowForBrand, selectDynamicQuestions }
