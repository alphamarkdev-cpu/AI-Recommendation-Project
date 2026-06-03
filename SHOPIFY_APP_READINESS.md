# AlphaMark Shopify App Readiness

This app is designed as a category-neutral product recommendation app. A merchant can configure any brand category, such as skincare, fragrance, pet care, fitness, apparel, electronics, home decor, or supplements.

## Current App Surface

- Shopify OAuth install flow at `/shopify`.
- Embedded Shopify Admin dashboard at `/shopify?shop=...`.
- Brand settings for custom category and widget color.
- Storefront theme app extension loading `/public/alphamark-shopify-widget.js`.
- Storefront widget loads the category-neutral `/widget` experience.
- Shopify uninstall webhook at `/webhooks/app/uninstalled`.
- Shopify scopes update webhook at `/webhooks/app/scopes_update`.

## Required Railway Variables

- `SUPABASE_URL`
- `SUPABASE_KEY` using the Supabase service role key
- `GEMINI_API_KEY`
- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_SCOPES=read_products`
- `SHOPIFY_APP_URL=https://ai-recommendation-project-production.up.railway.app`
- `SHOPIFY_API_VERSION=2025-10`

## Brand Category Rules

- Do not hardcode category choices in the Shopify app.
- Store the merchant's category in `brands.product_category`.
- Use `general` as the default category for new installs.
- Generate question flows per brand and category in `brand_question_flows`.
- The storefront widget should use the connected shop config from `/api/shopify/brand-config?shop=...`.

## Before Public App Review

- Add a polished pricing/onboarding page if billing is required.
- Add privacy policy, terms of service, support email, and app listing assets.
- Test install, uninstall, reinstall, and theme app embed activation on more than one development store.
- Verify recommendations with at least three very different categories.
- Replace any sample product data before submitting.
