const express = require('express')
const {
  startShopifyInstall,
  updateShopifySettings,
  syncShopifyProducts,
  handleShopifyCallback,
  getShopBrandConfig,
  shopifyHealth
} = require('../controllers/shopifyController')

const router = express.Router()

// Starts Shopify OAuth installation.
router.get('/', startShopifyInstall)
// Saves brand-level Shopify app settings from the embedded admin dashboard.
router.post('/settings', express.urlencoded({ extended: false }), updateShopifySettings)
// Imports Shopify catalog products into the connected AlphaMark brand.
router.post('/products/sync', express.urlencoded({ extended: false }), syncShopifyProducts)
// Receives Shopify OAuth callback and stores the shop access token.
router.get('/callback', handleShopifyCallback)
// Simple browser-readable health page for app URL checks.
router.get('/health', shopifyHealth)
// Lets the storefront widget resolve a connected shop to its AlphaMark brand config.
router.get('/brand-config', getShopBrandConfig)

module.exports = router
