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

const parseGeminiJson = text => {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim()

  try {
    return JSON.parse(cleaned)
  } catch (error) {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')

    if (start === -1 || end === -1 || end <= start) throw error
    return JSON.parse(cleaned.slice(start, end + 1))
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
        if (
      advisorConfig.requires_photo &&
      !photoImage
    ) {
      return res.status(400).json({
        success: false,
        error:
          `This ${brandCategory} assessment requires a photo.`,
        requires_photo: true,
        photo_reason:
          advisorConfig.photo_reason
      })
    }
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
You are a ${brandCategory} advisor for ${brandName}.

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

TASK:

1. Validate photo relevance.
2. Use only visible signals relevant to this category.
3. Compare photo and text answers.
4. If answers conflict and no clarification answers exist:
   ask 2-3 stored clarification questions.
5. If clarification answers exist:
   resolve conflict.
6. Select the best 3-4 products.
7. Never invent products.
8. Avoid products containing restricted materials or ingredients.
9. Use product how_to_use, recommendation_step, and recommended_timing from AVAILABLE PRODUCTS when creating usage instructions.
10. If product how_to_use is generic, missing, or says "Use as directed by the brand", do not repeat it. Create a clear consumer routine instruction from product category, description, selected concern, timing, and routine step.
11. How-to-use text must explain amount, when to apply, frequency, order in routine, and any simple caution. It must sound like an AI advisor, not catalog copy.
12. Keep all responses short and consumer friendly.

OUTPUT RULES:

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
[] when false.

recommendation_confidence:
0-100

skin_assessment:
maximum 2 sentences.

concern_level:
"Mild"
"Moderate"
"Severe"

recommended_products:
3-4 items.

Product format:
{
  "product_name":"",
  "category":"",
  "price":0,
  "why_chosen":"",
  "how_to_use":"Concrete personalized instruction. Example: After cleansing, apply a thin even layer for 10-15 minutes, 2-3 times weekly, then rinse and moisturize. Avoid overusing on irritated skin."
}

${
isRoutineCategory
? `
For routine categories also return:

morning_routine:
2-4 items. Each item must be:
{
  "step":1,
  "product_name":"",
  "how_to_use":"Concrete amount, timing, frequency, and order.",
  "why_this_step":"Why this step helps the consumer's selected concern."
}

evening_routine:
2-4 items. Each item must be:
{
  "step":1,
  "product_name":"",
  "how_to_use":"Concrete amount, timing, frequency, and order.",
  "why_this_step":"Why this step helps the consumer's selected concern."
}

tips:
exactly 3 items.

lifestyle_recommendations:
exactly 4 items.

warning:null|string
`
: `
For non-routine categories return:

category_specific_suggestions:
exactly 3 items.

buying_tips:
exactly 3 items.

warning:null|string
`
}

Return ONLY valid JSON.
`

    // Step 5: Call Gemini
    const model  = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })
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

