const express = require('express')
const cors = require('cors')
require('dotenv').config()

const brandsRouter = require('./routes/brands')
const productsRouter = require('./routes/products')
const recommendRouter = require('./routes/recommend')
const supabase = require('./config/supabase')
const questionsRouter = require('./routes/questions')
const shopifyRouter = require('./routes/shopify')
const {
  handleAppUninstalledWebhook,
  handleAppScopesUpdateWebhook
} = require('./controllers/shopifyController')
const path = require('path')

const app = express()

app.use(cors())
app.use((req, res, next) => {
  req.traceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  next()
})
app.post(
  '/webhooks/app/uninstalled',
  express.raw({ type: 'application/json' }),
  handleAppUninstalledWebhook
)
app.post(
  '/webhooks/app/scopes_update',
  express.raw({ type: 'application/json' }),
  handleAppScopesUpdateWebhook
)
app.use(express.json({ limit: '10mb' }))

app.use('/api/brands', brandsRouter)
app.use('/api/products', productsRouter)
app.use('/api/recommend', recommendRouter)
app.use('/api/questions', questionsRouter)
app.use('/shopify', shopifyRouter)
app.use('/api/shopify', shopifyRouter)
const dashboardRouter = require('./routes/dashboard')
app.use('/api/dashboard', dashboardRouter)
// Serves public embed scripts such as the Shopify storefront widget loader.
app.use('/public', express.static(path.join(__dirname, 'public')))
app.use(express.static(path.join(__dirname)))

// Serves the category-neutral widget HTML file to the browser.
app.get('/widget', (req, res) => {
  res.sendFile(path.join(__dirname, 'alphamark-widget-v3.html'))
})

// Serve static dashboard assets (JS/CSS/sample data) so the prototype can be loaded.
app.use('/dashboard-static', express.static(path.join(__dirname, 'dashboard')))

// Simple health check route used to confirm that the API server is running.
app.get('/', (req, res) => {
  res.json({ message: 'AlphaMark AI Recommendation API is running' })
})

// temporary test route - no API key needed
// Returns all products directly from Supabase for quick local debugging.
app.get('/test-products', async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .select('*')
  if (error) return res.json({ error: error.message })
  res.json({ products: data })
})

// temporary test route - no API key needed
// Returns all brands directly from Supabase for quick local debugging.
app.get('/test-brands', async (req, res) => {
  const { data, error } = await supabase
    .from('brands')
    .select('*')
  if (error) return res.json({ error: error.message })
  res.json({ brands: data })
})
// Shows partial Supabase environment values so local setup can be checked safely.
app.get('/debug-env', (req, res) => {
  res.json({
    supabase_url: process.env.SUPABASE_URL,
    supabase_key_first10: process.env.SUPABASE_KEY?.substring(0, 10)
  })
})
// Shows a partial Gemini key so API key loading can be checked without exposing it fully.
app.get('/debug-gemini', (req, res) => {
  res.json({
    gemini_key_first15: process.env.GEMINI_API_KEY?.substring(0, 15)
  })
})

// Returns fixed personal and lifestyle questions for debugging the question bank.
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

app.use((err, req, res, next) => {
  const status = err.statusCode || err.status || 500
  const traceId = req.traceId || 'no-trace'
  const details = process.env.NODE_ENV === 'production'
    ? undefined
    : err.stack

  console.error('Unhandled request error:', {
    traceId,
    method: req.method,
    path: req.originalUrl,
    status,
    message: err.message,
    stack: err.stack
  })

  if (res.headersSent) return next(err)

  res.status(status).json({
    success: false,
    error: err.message || 'Internal server error',
    trace_id: traceId,
    details
  })
})

const PORT = process.env.PORT || 3000
// Starts the Express server on the configured port.
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})

