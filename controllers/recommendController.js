const { GoogleGenerativeAI } = require('@google/generative-ai')
const supabase = require('../config/supabase')
const { getMatchingProducts } = require('./productsController')
const { formatGeminiUsage } = require('../utils/geminiUsage')
require('dotenv').config()

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

const asArray = value => Array.isArray(value) ? value : []

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

  const questions = Array.isArray(data?.questions_json)
    ? data.questions_json
    : []
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

    // Step 4: Clean AI prompt .
    const prompt = `
You are an expert ${brandCategory} advisor for ${brandName}.

CONSUMER PROFILE:
- Brand category: ${brandCategory}
- Customer type / profile attribute: ${profileTypes.join(', ')}
- Primary concern: ${concernsList.join(', ')}
- Age: ${age}
- Concern duration: ${durationInput || 'Not specified'}
- Known allergies: ${allergies || 'None'}
- Budget: ${budget || 'Not specified'}
- Details: ${additional_info || 'None'}
- Photo: ${photoImage ? `Uploaded photo is attached for ${brandCategory} visual analysis` : 'Not provided'}
- Clarification answers: ${hasClarificationAnswers ? JSON.stringify(clarification_answers, null, 2) : 'None yet'}

AVAILABLE PRODUCTS IN DATABASE (ONLY use these â€” do NOT invent products):
${JSON.stringify(productsContext, null, 2)}

AVAILABLE STORED CLARIFICATION QUESTIONS:
${JSON.stringify(clarificationCandidates, null, 2)}

YOUR TASK:
1. If a photo is attached, first verify that the photo is relevant to the brand category.
2. Decide relevance from the brand category, product catalogue, and the consumer's selected concern. Example: for apparel the image should show clothing/body fit context; for footwear it should show feet/shoes/wear context; for beauty it should show the relevant body area or product-use context; for pet care it should show the pet or product-use context; for home goods it should show the space or item context.
3. If the uploaded photo is not relevant to the brand category, return blocked=true in photo_verification and do not create product routines.
4. If the photo is relevant, inspect only the visible signals that are useful for this specific category and concern. Do not force assumptions from any other vertical.
5. Compare photo evidence with the consumer's text answers.
6. If text answers and photo evidence conflict and clarification answers are "None yet", ask 2-3 extra questions from AVAILABLE STORED CLARIFICATION QUESTIONS before creating a routine.
7. Clarification questions must be copied exactly from AVAILABLE STORED CLARIFICATION QUESTIONS and must not repeat already answered fields.
8. If clarification answers are present, use them to resolve the conflict and create the final recommendation.
9. If text and photo do not conflict, create the final recommendation immediately.
10. Pick the best 3-4 products from the list above that match the resolved profile.
11. Skip any product with components, materials, ingredients, or restrictions the consumer is allergic or sensitive to.
12. Build a morning AND evening routine using only those products.
13. Keep all text SHORT, CLEAR, and consumer-friendly.
14. Write routine copy like a premium card: benefit-led, warm, and easy to scan.
15. Add lifestyle recommendations based on the consumer's sleep, water, diet, stress, activity, city, occupation, smoking/drinking, sugar intake, and other lifestyle answers.

STRICT RULES:
- photo_verification.blocked: true only when the uploaded photo is irrelevant to the brand category or cannot be assessed.
- photo_verification.message: consumer-friendly one sentence explaining the blocker, or null when not blocked.
- clarification_required: true only when the relevant photo and text answers conflict and clarification answers are not yet provided.
- clarification_questions: when clarification_required is true, return exactly 2 or 3 question objects from AVAILABLE STORED CLARIFICATION QUESTIONS.
- clarification_questions: when clarification_required is false, return [].
- If fewer than 2 AVAILABLE STORED CLARIFICATION QUESTIONS exist, do not ask clarification questions; resolve the recommendation from the best available evidence.
- If clarification_required is true, leave morning_routine, evening_routine, tips, and lifestyle_recommendations as empty arrays.
- recommendation_basis: exactly one of "text_answers", "photo", "text_and_photo", or "no_photo".
- basis_explanation: one short sentence. If text and photo conflict, say which signal was stronger and why.
- skin_assessment: MAX 2 sentences. Keep this key name for API compatibility, but write a category-specific customer assessment rather than a skin-only assessment.
- concern_level: exactly one of "Mild", "Moderate", or "Severe"
- how_to_use: MAX 1 clear action sentence suited to this product category.
- why_chosen: MAX 1 benefit-led sentence - mention their specific concern and why this product helps
- time_to_apply: specific time e.g. "After waking up" or "Before sleeping"
- lifestyle_recommendations: exactly 4 items, practical and personalised to their lifestyle answers
- lifestyle title: MAX 4 words
- lifestyle action: MAX 1 catchy, specific sentence
- lifestyle reason: MAX 1 short benefit sentence connected to the product category and customer goal.
- tips: exactly 3 short tips based on their lifestyle answers
- warning: one line only, or null if no warning

Respond ONLY in this exact JSON â€” no markdown, no extra text:
{
  "photo_verification": {
    "blocked": false,
    "is_relevant": true,
    "detected_subject": "relevant subject for the brand category",
    "message": null
  },
  "recommendation_basis": "text_and_photo",
  "basis_explanation": "The routine uses both your answers and useful visible signals from the uploaded photo.",
  "clarification_required": false,
  "clarification_reason": null,
  "clarification_questions": [],
  "skin_assessment": "2 sentences max about their specific need or goal.",
  "concern_level": "Mild",
  "morning_routine": [
    {
      "step": 1,
      "product_name": "exact name from database",
      "category": "exact category from database",
      "time_to_apply": "Best time or situation to use this product",
      "how_to_use": "One catchy action sentence",
      "why_chosen": "One benefit-led reason for this consumer",
      "price": 0
    }
  ],
  "evening_routine": [
    {
      "step": 1,
      "product_name": "exact name from database",
      "category": "exact category from database",
      "time_to_apply": "30 minutes before sleeping",
      "how_to_use": "One catchy action sentence",
      "why_chosen": "One benefit-led reason for this consumer",
      "price": 0
    }
  ],
  "tips": [
    "Short tip 1 based on their lifestyle",
    "Short tip 2",
    "Short tip 3"
  ],
  "lifestyle_recommendations": [
    {
      "title": "Hydration rhythm",
      "action": "Drink a glass of water before every tea or coffee.",
      "reason": "A small supportive habit can help this routine work more consistently."
    }
  ],
  "warning": null
}
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
      success: true,
      recommendation,
      product_images: productImages,
      product_urls:   productUrls,
      photo_used: Boolean(photoImage),
      ai_usage: aiUsage
    })

  } catch (error) {
  console.error('RECOMMEND ERROR:', error)

  res.status(500).json({
    error: error.message,
    stack: error.stack
  })
}
}

module.exports = { getRecommendation }


