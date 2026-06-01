const { GoogleGenerativeAI } = require('@google/generative-ai')
const supabase = require('../config/supabase')
const { getMatchingProducts } = require('./productsController')
const { formatGeminiUsage } = require('../utils/geminiUsage')
require('dotenv').config()

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

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
      ingredients(*),
      concern_tags(*)
    `)
    .eq('brand_id', brandId)
    .eq('is_active', true)

  if (error) throw error
  return data || []
}

// Creates a personalized recommendation by matching products, prompting Gemini, and saving the session.
const getRecommendation = async (req, res) => {
  try {
    const {
      skin_type,
      concerns,
      age,
      acne_duration,
      allergies,
      budget,
      additional_info,
      photo_analysis,
      photo_image,
      all_answers
    } = req.body

    const brandId   = req.brand.brand_id
    const brandName = req.brand.name
    const brandCategory = req.brand.product_category || req.brand.category || 'skincare'

    const skinTypes    = Array.isArray(skin_type) ? skin_type : [skin_type]
    const concernsList = Array.isArray(concerns)  ? concerns  : [concerns]
    const photoImage = parseDataUrlImage(photo_image)

    // . Step 1: Fetch matching products .
    const matchingProducts = photoImage
      ? await getActiveBrandProducts(brandId)
      : await getMatchingProducts(brandId, skinTypes, concernsList)

    if (!matchingProducts || matchingProducts.length === 0) {
      return res.status(404).json({
        error: 'No matching products found in our database for this concern.'
      })
    }

    // . Step 2: Build product context for AI .
    const productsContext = matchingProducts.map(p => ({
      name:                p.name,
      category:            p.category,
      usage_step:          p.usage_step,
      time_of_day:         p.time_of_day,
      description:         p.description,
      how_to_use:          p.how_to_use,
      price:               p.price,
      suitable_skin_types: p.suitable_skin_types,
      concerns_it_solves:  p.concern_tags.map(t => `${t.concern} (severity ${t.severity_level}, priority ${t.priority_score})`),
      key_ingredients:     p.ingredients.map(i => i.name)
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
- Skin/Hair/Body type: ${skinTypes.join(', ')}
- Primary concern: ${concernsList.join(', ')}
- Age: ${age}
- Concern duration: ${acne_duration || 'Not specified'}
- Known allergies: ${allergies || 'None'}
- Budget: ${budget || 'Not specified'}
- Details: ${additional_info || 'None'}
- Photo: ${photoImage ? 'Uploaded skin photo is attached for visual analysis' : 'Not provided'}

AVAILABLE PRODUCTS IN DATABASE (ONLY use these â€” do NOT invent products):
${JSON.stringify(productsContext, null, 2)}

YOUR TASK:
1. If a photo is attached, first verify that the photo is relevant to the brand category.
2. For skincare, a relevant photo should show inspectable skin such as face, neck, or another skin area. For haircare, a relevant photo should show hair, scalp, hairline, or a hair-density/texture view. For supplements, the photo is optional and should not be used unless it clearly helps with the selected wellness category.
3. If the uploaded photo is not relevant to the brand category, return blocked=true in photo_verification and do not create product routines.
4. If the photo is relevant, inspect visible signs for that category. For skincare: oiliness, redness, acne, texture, marks, tanning, pigmentation, dryness, irritation. For haircare: scalp visibility, flakes, oiliness, density, thinning, hairline, dryness, frizz, damage.
5. Compare photo evidence with the consumer's text answers.
6. If text answers and photo evidence conflict, choose the stronger basis and explain it in recommendation_basis and basis_explanation.
7. Pick the best 3-4 products from the list above that match the chosen basis.
8. Skip any product with ingredients the consumer is allergic to.
9. Build a morning AND evening routine using only those products.
10. Keep all text SHORT, CLEAR, and consumer-friendly.
11. Write routine copy like a premium card: benefit-led, warm, and easy to scan.
12. Add lifestyle recommendations based on the consumer's sleep, water, diet, stress, activity, city, occupation, smoking/drinking, sugar intake, and other lifestyle answers.

STRICT RULES:
- photo_verification.blocked: true only when the uploaded photo is irrelevant to the brand category or cannot be assessed.
- photo_verification.message: consumer-friendly one sentence explaining the blocker, or null when not blocked.
- recommendation_basis: exactly one of "text_answers", "photo", "text_and_photo", or "no_photo".
- basis_explanation: one short sentence. If text and photo conflict, say which signal was stronger and why.
- skin_assessment: MAX 2 sentences â€” be specific about their concern
- concern_level: exactly one of "Mild", "Moderate", or "Severe"
- how_to_use: MAX 1 catchy action sentence e.g. "Smooth 2 drops over clean skin for a fresh, calm finish"
- why_chosen: MAX 1 benefit-led sentence - mention their specific concern and why this product helps
- time_to_apply: specific time e.g. "After waking up" or "Before sleeping"
- lifestyle_recommendations: exactly 4 items, practical and personalised to their lifestyle answers
- lifestyle title: MAX 4 words
- lifestyle action: MAX 1 catchy, specific sentence
- lifestyle reason: MAX 1 short benefit sentence connected to skin/hair/wellness
- tips: exactly 3 short tips based on their lifestyle answers
- warning: one line only, or null if no warning

Respond ONLY in this exact JSON â€” no markdown, no extra text:
{
  "photo_verification": {
    "blocked": false,
    "is_relevant": true,
    "detected_subject": "face skin",
    "message": null
  },
  "recommendation_basis": "text_and_photo",
  "basis_explanation": "The routine uses both your answers and visible skin signs from the uploaded photo.",
  "skin_assessment": "2 sentences max about their specific condition.",
  "concern_level": "Mild",
  "morning_routine": [
    {
      "step": 1,
      "product_name": "exact name from database",
      "category": "exact category from database",
      "time_to_apply": "After waking up, on clean face",
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
      "reason": "Steady hydration can support a fresher, less tired-looking complexion."
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
    const text   = result.response.text()
    const clean  = text.replace(/```json|```/g, '').trim()
    const recommendation = JSON.parse(clean)

    if (photoImage && recommendation.photo_verification?.blocked) {
      return res.status(422).json({
        success: false,
        error: recommendation.photo_verification.message || `The uploaded photo does not match this ${brandCategory} assessment. Please upload a relevant photo or continue without a photo.`,
        photo_used: true,
        photo_verification: recommendation.photo_verification,
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
          skin_type: skinTypes,
          concerns:  concernsList,
          age, acne_duration, allergies, budget,
          additional_info,
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
    console.error('Recommendation error:', error)
    res.status(500).json({ error: error.message })
  }
}

module.exports = { getRecommendation }


