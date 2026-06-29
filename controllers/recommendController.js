const { GoogleGenerativeAI } = require('@google/generative-ai')
const supabase = require('../config/supabase')
const { getMatchingProducts } = require('./productsController')
const { formatGeminiUsage } = require('../utils/geminiUsage')
require('dotenv').config()

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

const asArray = value => Array.isArray(value) ? value : []

const parseJsonColumn = (value, fallback) => {
  if (!value) return fallback
  if (typeof value !== 'string') return value

  try {
    return JSON.parse(value)
  } catch (error) {
    return fallback
  }
}

const extractFirstJsonObject = text => {
  const start = text.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\' && inString) {
      escaped = true
      continue
    }

    if (char === '"') {
      inString = !inString
      continue
    }

    if (inString) continue

    if (char === '{') depth += 1
    if (char === '}') depth -= 1

    if (depth === 0) {
      return text.slice(start, index + 1)
    }
  }

  return null
}

const parseGeminiJson = text => {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim()

  try {
    return JSON.parse(cleaned)
  } catch (error) {
    const firstObject = extractFirstJsonObject(cleaned)
    if (!firstObject) throw error
    return JSON.parse(firstObject)
  }
}

// Converts a browser data URL image into Gemini's inlineData shape.
const parseDataUrlImage = dataUrl => {
  if (!dataUrl || typeof dataUrl !== 'string') return null

  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/)
  if (!match) return null

  return {
    mimeType: match[1],
    data: match[2]
  }
}

const isGenericUsageText = value => {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return true

  return [
    'use as directed by the brand',
    'use as directed',
    'as needed'
  ].some(phrase => text.includes(phrase))
}

const buildPersonalizedUsage = (item = {}) => {
  const category = String(item.category || '').toLowerCase()
  const productName = item.product_name || item.name || 'this product'
  const timing = item.when_to_apply || item.time_to_apply || item.recommended_timing || ''
  const isMask = category.includes('mask') || String(productName).toLowerCase().includes('mask')

  if (isMask) {
    return 'After cleansing, apply a thin even layer on clean skin, leave it for 10-15 minutes, then rinse and follow with moisturizer. Use 2-3 times weekly, and avoid using on irritated skin.'
  }

  if (category.includes('cleanser') || String(productName).toLowerCase().includes('cleanser')) {
    return 'Use on damp skin as the first step, massage gently for 30-60 seconds, then rinse well. Use once or twice daily depending on comfort.'
  }

  if (category.includes('serum') || String(productName).toLowerCase().includes('serum')) {
    return 'After cleansing, apply 2-3 drops to dry skin, then follow with moisturizer. Start once daily and reduce frequency if your skin feels irritated.'
  }

  if (category.includes('moistur') || String(productName).toLowerCase().includes('cream')) {
    return 'Apply a small amount after serum or treatment steps to seal in hydration. Use morning and evening, or whenever the skin feels dry.'
  }

  if (category.includes('sunscreen') || String(productName).toLowerCase().includes('spf')) {
    return 'Use as the final morning step. Apply generously 15 minutes before sun exposure and reapply every 2-3 hours when outdoors.'
  }

  return `Use ${timing ? `${timing.toLowerCase()} ` : ''}as part of the recommended routine. Apply a small amount, follow lighter products before heavier ones, and start gradually to check comfort.`
}

const improveUsageInstructions = items => {
  asArray(items).forEach(item => {
    if (isGenericUsageText(item?.how_to_use)) {
      item.how_to_use = buildPersonalizedUsage(item)
    }
  })
}

const addProductContextToItems = (items, productByName) => {
  asArray(items).forEach(item => {
    const product = productByName.get(item?.product_name)
    if (!product) return

    item.category = item.category || product.category
    item.price = item.price || product.price
    item.recommended_timing = item.recommended_timing || product.recommended_timing
  })
}

const getActiveBrandProducts = async brandId => {
  const { data, error } = await supabase
    .from('products')
    .select(`
      *,
      product_components(*),
      product_match_tags(*)
    `)
    .eq('brand_id', brandId)
    .eq('is_active', true)

  if (error) throw error
  return data || []
}

const getClarificationCandidates = async (brandId, category, answeredFields = []) => {
  const { data, error } = await supabase
    .from('brand_question_flows')
    .select('questions_json')
    .eq('brand_id', brandId)
    .eq('category', category)
    .eq('is_active', true)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error

  const questionsJson = parseJsonColumn(data?.questions_json, [])
  const questions = Array.isArray(questionsJson)
    ? questionsJson
    : questionsJson.questions || []
  const answered = new Set(answeredFields.filter(Boolean))

  return questions
    .filter(question => question?.field_key && !answered.has(question.field_key))
    .filter(question => ['chips', 'cards', 'scale', 'text'].includes(question.input_type))
    .slice(0, 12)
    .map(question => ({
      question_id: question.question_id,
      field_key: question.field_key,
      question_text: question.question_text,
      sub_text: question.sub_text || '',
      input_type: question.input_type,
      options_json: question.options_json || [],
      category: question.category || category,
      section_label: question.section_label || 'Clarification'
    }))
}

// Creates a personalized recommendation by matching products, prompting Gemini, and saving the session.
const getRecommendation = async (req, res) => {
  try {
    const {
      profile_type,
      skin_type,
      concerns,
      age,
      concern_duration,
      acne_duration,
      allergies,
      budget,
      additional_info,
      photo_analysis,
      photo_image,
      all_answers,
      clarification_answers
    } = req.body

    const brandId   = req.brand.brand_id
    const brandName = req.brand.name
    const brandCategory = req.brand.product_category || req.brand.category || 'general'
    const { data: flowConfig, error: flowError } =
    await supabase
      .from('brand_question_flows')
      .select(`
        advisor_config,
        recommendation_schema
      `)
      .eq('brand_id', brandId)
      .eq('category', brandCategory)
      .eq('is_active', true)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (flowError) throw flowError

    const advisorConfig = parseJsonColumn(flowConfig?.advisor_config, {})

    const recommendationSchema = parseJsonColumn(flowConfig?.recommendation_schema, {})

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on this deployment.' })
    }

    const profileInput = profile_type || skin_type
    const durationInput = concern_duration || acne_duration
    const profileTypes = Array.isArray(profileInput) ? profileInput : [profileInput]
    const concernsList = Array.isArray(concerns)  ? concerns  : [concerns]
    const photoImage = parseDataUrlImage(photo_image)
    const hasClarificationAnswers = clarification_answers &&
      typeof clarification_answers === 'object' &&
      Object.keys(clarification_answers).length > 0
    const answeredFields = [
      ...Object.keys(all_answers || {}),
      ...Object.keys(clarification_answers || {})
    ]
    const clarificationCandidates = photoImage && !hasClarificationAnswers
      ? await getClarificationCandidates(brandId, brandCategory, answeredFields)
      : []
    const requiresRoutine =
      advisorConfig.requires_routine

      const recommendationStyle =
      advisorConfig.recommendation_style ||
            'products'
      const isRoutineCategory =
      requiresRoutine || recommendationStyle === 'routine'

      const isProductCategory =
      recommendationStyle === 'products'

    // . Step 1: Fetch matching products .
    const matchingProducts = photoImage
      ? await getActiveBrandProducts(brandId)
      : await getMatchingProducts(brandId, profileTypes, concernsList)

    if (!matchingProducts || matchingProducts.length === 0) {
      return res.status(404).json({
        error: 'No matching products found in our database for this concern.'
      })
    }

    // . Step 2: Build product context for AI .
    const productsContext = matchingProducts.map(p => ({
      name:                p.name,
      category:            p.category,
      recommendation_step: p.recommendation_step,
      recommended_timing:  p.recommended_timing,
      description:         p.description,
      how_to_use:          p.how_to_use,
      price:               p.price,
      suitable_customer_attributes: p.suitable_customer_attributes,
      match_tags:          asArray(p.product_match_tags).map(t => `${t.match_tag} (intensity ${t.intensity_level}, priority ${t.priority_score})`),
      key_components:      asArray(p.product_components).map(i => i.name)
    }))

    // . Step 3: Build product image + URL maps to send back to frontend .
    const productImages = {}
    const productUrls   = {}
    matchingProducts.forEach(p => {
      productImages[p.name] = p.image_url  || null
      productUrls[p.name]   = p.product_url || null
    })
    const productByName = new Map(productsContext.map(product => [product.name, product]))

    const aiWeights =
      recommendationSchema.weights ||
      advisorConfig.recommendation_weights ||
      advisorConfig.weights ||
      {}

    const aiProducts = productsContext.slice(0, 20)
    const aiClarifications = clarificationCandidates.map(question => ({
      field_key: question.field_key,
      question_text: question.question_text,
      input_type: question.input_type,
      options_json: question.options_json
    }))

    // Step 4: Clean AI prompt .
const prompt = `
You are an expert ${brandCategory} product advisor for ${brandName}.

Your role is to understand the customer's needs and recommend the most suitable products ONLY from the provided product catalog.

PROFILE:
${JSON.stringify({
  category: brandCategory,
  profile: profileTypes,
  concerns: concernsList,
  age,
  duration: durationInput,
  allergies,
  budget,
  details: additional_info
})}

PHOTO:
${
photoImage
? advisorConfig.photo_reason
: 'none'
}

CLARIFICATION ANSWERS:
${
hasClarificationAnswers
? JSON.stringify(clarification_answers)
: 'none'
}

RECOMMENDATION WEIGHTS:
${JSON.stringify(aiWeights)}

AVAILABLE PRODUCTS:
${JSON.stringify(aiProducts)}

CLARIFICATION QUESTIONS:
${JSON.stringify(aiClarifications)}

====================================================
TASK
====================================================

1. Understand the customer's profile, concerns and preferences.

2. If a photo is uploaded, validate whether it is useful for this product category.

3. Only analyze information that is visually relevant for this category.

Examples:

• Skincare
  - skin texture
  - acne
  - pigmentation
  - redness
  - oiliness

• Haircare
  - hair texture
  - scalp condition
  - hair density

• Fashion
  - clothing style
  - color preference
  - body fit (only when obvious)

• Eyewear
  - face shape

• Jewelry
  - outfit compatibility

• Furniture
  - room appearance

• Electronics
  - ignore the photo unless useful.

Never infer personal attributes that are not clearly visible.

4. If a photo is uploaded, compare photo findings with questionnaire answers.

5. If answers conflict AND clarification answers do not exist:
   Ask ONLY 2–3 clarification questions from CLARIFICATION QUESTIONS.

6. If clarification answers exist:
   Resolve conflicts before recommending products.

7. Recommend ONLY products present in AVAILABLE PRODUCTS.

8. Never invent product names.

9. Never invent prices.

10. Never recommend unavailable products.

11. Avoid recommending products containing restricted ingredients, materials or components whenever relevant.

12. Use product metadata whenever available:
   - how_to_use
   - recommendation_step
   - recommended_timing
   - category
   - description

13. If usage instructions are missing or generic,
create simple consumer-friendly instructions based on:

• product category
• product description
• customer concern
• timing
• routine step

14. Usage instructions should explain only what is useful:

• amount (if applicable)
• timing
• order
• frequency
• simple precautions

15. Keep every explanation concise.

16. Write for normal consumers.

17. Avoid medical language.

18. Avoid marketing language.

19. Prefer bullet points instead of paragraphs.

20. Never repeat the same information.

====================================================
OUTPUT
====================================================

photo_verification:
{
  blocked:boolean,
  is_relevant:boolean,
  detected_subject:string,
  message:string|null
}

recommendation_basis:
"text_answers"
"photo"
"text_and_photo"
"no_photo"

clarification_required:boolean

clarification_questions:
[] when false

recommendation_confidence:
0-100

customer_assessment:
Exactly 2 short bullet points describing the customer's needs.

priority_level:
"Low"
"Medium"
"High"

recommended_products:
Return 3-4 products.

Each product:

{
  "product_name":"",
  "category":"",
  "price":0,

  "why_chosen":[
      "Maximum 2 short bullet points"
  ],

  "how_to_use":[
      "Maximum 3 short bullet points"
  ]
}

${
isRoutineCategory
?
`
For categories where products are used in a routine
(such as skincare, haircare, oral care, supplements, etc.)

Return:

morning_routine:
2-4 steps

Each step:

{
   "step":1,
   "product_name":"",
   "how_to_use":[
      "Maximum 2 short bullet points"
   ],
   "why_this_step":"One short sentence"
}

evening_routine:
2-4 steps

Same format.

tips:
Exactly 3 short bullet points.

lifestyle_recommendations:
Exactly 4 short bullet points.

warning:
null or one short sentence.
`
:
`
For non-routine categories
(such as fashion, electronics, furniture, jewelry, watches, home decor, accessories, etc.)

Return:

category_specific_suggestions:
Exactly 3 short bullet points.

buying_tips:
Exactly 3 short bullet points.

warning:
null or one short sentence.
`
}

====================================================
STYLE RULES
====================================================

• Keep every sentence under 15 words.

• Prefer bullet points.

• Never write long paragraphs.

• Never repeat information.

• Sound like a premium shopping advisor.

• Be concise.

• Be personalized.

Return ONLY valid JSON.
`

    // Step 5: Call Gemini
    const model  = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        responseMimeType: 'application/json'
      }
    })
    const request = photoImage
      ? [
          { text: prompt },
          {
            inlineData: {
              mimeType: photoImage.mimeType,
              data: photoImage.data
            }
          }
        ]
      : prompt
    const result = await model.generateContent(request)
    const aiUsage = formatGeminiUsage(result.response.usageMetadata)
    const recommendation = parseGeminiJson(result.response.text())
    recommendation.recommended_products =
    recommendation.recommended_products || []

    recommendation.morning_routine =
    recommendation.morning_routine || []

    recommendation.evening_routine =
    recommendation.evening_routine || []

    recommendation.lifestyle_recommendations =
    recommendation.lifestyle_recommendations || []

    recommendation.category_specific_suggestions =
    recommendation.category_specific_suggestions || []

    recommendation.buying_tips =
    recommendation.buying_tips || []

    addProductContextToItems(recommendation.recommended_products, productByName)
    addProductContextToItems(recommendation.morning_routine, productByName)
    addProductContextToItems(recommendation.evening_routine, productByName)

    improveUsageInstructions(recommendation.recommended_products)
    improveUsageInstructions(recommendation.morning_routine)
    improveUsageInstructions(recommendation.evening_routine)

    if (photoImage && recommendation.photo_verification?.blocked) {
      return res.status(422).json({
        success: false,
        error: recommendation.photo_verification.message || `The uploaded photo does not match this ${brandCategory} assessment. Please upload a relevant photo or continue without a photo.`,
        photo_used: true,
        photo_verification: recommendation.photo_verification,
        ai_usage: aiUsage
      })
    }

    if (recommendation.clarification_required && Array.isArray(recommendation.clarification_questions)) {
      const candidateByField = new Map(clarificationCandidates.map(question => [question.field_key, question]))
      const selectedClarificationQuestions = recommendation.clarification_questions
        .map(question => candidateByField.get(question.field_key))
        .filter(Boolean)
        .slice(0, 3)

      if (selectedClarificationQuestions.length < 2) {
        throw new Error('Gemini requested clarification but did not choose at least 2 stored clarification questions.')
      }

      return res.json({
        success: true,
        needs_clarification: true,
        clarification_reason: recommendation.clarification_reason || 'A few more details will help us match your answers with the uploaded photo.',
        clarification_questions: selectedClarificationQuestions,
        photo_verification: recommendation.photo_verification || null,
        photo_used: Boolean(photoImage),
        ai_usage: aiUsage
      })
    }

    console.log('Gemini token usage - recommendation:', aiUsage)
    
    // . Step 6: Save session .
    const { error: sessionError } = await supabase
      .from('consumer_sessions')
      .insert({
        brand_id: brandId,
        answers_json: {
          profile_type: profileTypes,
          concerns:  concernsList,
          age,
          concern_duration: durationInput,
          allergies,
          budget,
          additional_info,
          clarification_answers: clarification_answers || null,
          ...(all_answers || {})
        },
        photo_analysis_json: photoImage
          ? {
              result: photo_analysis,
              mime_type: photoImage.mimeType,
              verification: recommendation.photo_verification || null,
              recommendation_basis: recommendation.recommendation_basis || null,
              basis_explanation: recommendation.basis_explanation || null
            }
          : null,
        recommended_product_ids: matchingProducts.map(p => p.product_id)
      })

    if (sessionError) console.error('Session save error:', sessionError)

    // . Step 7: Return result with product images and URLs .
res.json({
  success:true,
  recommendation,
  advisor_config:
    advisorConfig,
  recommendation_schema:
    recommendationSchema,
  product_images:
    productImages,
  product_urls:
    productUrls,
  photo_used:
    Boolean(photoImage),
  ai_usage:
    aiUsage
})

  } catch (error) {
    const traceId = req.traceId || `${Date.now().toString(36)}-recommend`
    console.error('Recommendation error:', {
      traceId,
      message: error.message,
      stack: error.stack
    })

    res.status(500).json({
      success: false,
      error: error.message,
      trace_id: traceId,
      details: process.env.NODE_ENV === 'production' ? undefined : error.stack
    })
  }
}

module.exports = { getRecommendation }

