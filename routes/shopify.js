const express = require('express')
const {
  startShopifyInstall,
  handleShopifyCallback,
  getShopBrandConfig,
  shopifyHealth
} = require('../controllers/shopifyController')

const router = express.Router()

// Starts Shopify OAuth installation.
router.get('/', startShopifyInstall)
// Receives Shopify OAuth callback and stores the shop access token.
router.get('/callback', handleShopifyCallback)
// Simple browser-readable health page for app URL checks.
router.get('/health', shopifyHealth)
// Lets the storefront widget resolve a connected shop to its AlphaMark brand config.
router.get('/brand-config', getShopBrandConfig)

module.exports = router
