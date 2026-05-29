const express = require('express')
const cors = require('cors')
require('dotenv').config()

const brandsRouter = require('./routes/brands')
const productsRouter = require('./routes/products')
const recommendRouter = require('./routes/recommend')
const supabase = require('./config/supabase')
const questionsRouter = require('./routes/questions')
const path = require('path')

const app = express()

app.use(cors())
app.use(express.json())

app.use('/api/brands', brandsRouter)
app.use('/api/products', productsRouter)
app.use('/api/recommend', recommendRouter)
app.use('/api/questions', questionsRouter)
app.use(express.static(path.join(__dirname)))

app.get('/widget', (req, res) => {
  res.sendFile(path.join(__dirname, 'alphamark-widget-v3.html'))
})
app.get('/widget-hair', (req, res) => {
  res.sendFile(path.join(__dirname, 'alphamark-widget-hair.html'))
})
app.get('/widget-supplements', (req, res) => {
  res.sendFile(path.join(__dirname, 'alphamark-widget-supplements.html'))
})

app.get('/', (req, res) => {
  res.json({ message: 'AlphaMark AI Recommendation API is running' })
})

// temporary test route - no API key needed
app.get('/test-products', async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .select('*')
  if (error) return res.json({ error: error.message })
  res.json({ products: data })
})

// temporary test route - no API key needed
app.get('/test-brands', async (req, res) => {
  const { data, error } = await supabase
    .from('brands')
    .select('*')
  if (error) return res.json({ error: error.message })
  res.json({ brands: data })
})
app.get('/debug-env', (req, res) => {
  res.json({
    supabase_url: process.env.SUPABASE_URL,
    supabase_key_first10: process.env.SUPABASE_KEY?.substring(0, 10)
  })
})
app.get('/debug-gemini', (req, res) => {
  res.json({
    gemini_key_first15: process.env.GEMINI_API_KEY?.substring(0, 15)
  })
})

app.get('/test-fixed-questions', async (req, res) => {
  const supabase = require('./config/supabase')
  const { data, error } = await supabase
    .from('question_bank')
    .select('*')
    .in('category', ['personal', 'lifestyle'])
    .eq('is_fixed', true)
    .order('category')
    .order('display_order')
  if (error) return res.json({ error: error.message })
  res.json({ total: data.length, questions: data })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})


