const { GoogleGenerativeAI } = require('@google/generative-ai')
const supabase = require('../config/supabase')
const { getMatchingProducts } = require('./productsController')
require('dotenv').config()

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

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
      all_answers
    } = req.body

    const brandId   = req.brand.brand_id
    const brandName = req.brand.name

    const skinTypes    = Array.isArray(skin_type) ? skin_type : [skin_type]
    const concernsList = Array.isArray(concerns)  ? concerns  : [concerns]

    // â”€â”€ Step 1: Fetch matching products â”€â”€
    const matchingProducts = await getMatchingProducts(brandId, skinTypes, concernsList)

    if (!matchingProducts || matchingProducts.length === 0) {
      return res.status(404).json({
        error: 'No matching products found in our database for this concern.'
      })
    }

    // â”€â”€ Step 2: Build product context for AI â”€â”€
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

    // â”€â”€ Step 3: Build product image + URL maps to send back to frontend â”€â”€
    const productImages = {}
    const productUrls   = {}
    matchingProducts.forEach(p => {
      productImages[p.name] = p.image_url  || null
      productUrls[p.name]   = p.product_url || null
    })

    // â”€â”€ Step 4: Clean AI prompt â”€â”€
    const prompt = `
You are an expert skincare and wellness advisor for ${brandName}.

CONSUMER PROFILE:
- Skin/Hair/Body type: ${skinTypes.join(', ')}
- Primary concern: ${concernsList.join(', ')}
- Age: ${age}
- Concern duration: ${acne_duration || 'Not specified'}
- Known allergies: ${allergies || 'None'}
- Budget: ${budget || 'Not specified'}
- Details: ${additional_info || 'None'}
- Photo: ${photo_analysis || 'Not provided'}

AVAILABLE PRODUCTS IN DATABASE (ONLY use these â€” do NOT invent products):
${JSON.stringify(productsContext, null, 2)}

YOUR TASK:
1. Pick the best 3-4 products from the list above that match this consumer
2. Skip any product with ingredients the consumer is allergic to
3. Build a morning AND evening routine using only those products
4. Keep all text SHORT, CLEAR, and consumer-friendly
5. Write routine copy like a premium skincare card: benefit-led, warm, and easy to scan
6. Add lifestyle recommendations based on the consumer's sleep, water, diet, stress, activity, city, occupation, smoking/drinking, sugar intake, and other lifestyle answers

STRICT RULES:
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

    // â”€â”€ Step 5: Call Gemini â”€â”€
    const model  = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })
    const result = await model.generateContent(prompt)
    const text   = result.response.text()
    const clean  = text.replace(/```json|```/g, '').trim()
    const recommendation = JSON.parse(clean)

    // â”€â”€ Step 6: Save session â”€â”€
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
        photo_analysis_json:     photo_analysis ? { result: photo_analysis } : null,
        recommended_product_ids: matchingProducts.map(p => p.product_id)
      })

    if (sessionError) console.error('Session save error:', sessionError)

    // â”€â”€ Step 7: Return result with product images and URLs â”€â”€
    res.json({
      success: true,
      recommendation,
      product_images: productImages,
      product_urls:   productUrls
    })

  } catch (error) {
    console.error('Recommendation error:', error)
    res.status(500).json({ error: error.message })
  }
}

module.exports = { getRecommendation }


