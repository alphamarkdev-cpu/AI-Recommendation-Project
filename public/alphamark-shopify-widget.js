(function () {
  const script = document.currentScript
  const apiUrl = (script?.dataset.apiUrl || new URL(script.src).origin).replace(/\/$/, '')
  const configuredBrandKey = script?.dataset.brandKey === 'test-api-key-001'
    ? ''
    : script?.dataset.brandKey || ''
  const shopDomain = script?.dataset.shopDomain || window.Shopify?.shop || ''
  let brandKey = configuredBrandKey
  let category = script?.dataset.category || 'general'
  const buttonText = script?.dataset.buttonText || 'Find My Match'
  let accentColor = script?.dataset.accentColor || '#1B4332'
  const position = script?.dataset.position || 'bottom-right'

  // Builds a URL for the iframe-hosted AlphaMark widget with brand-specific settings.
  function widgetUrl() {
    const url = new URL('/widget', apiUrl)
    url.searchParams.set('embed', '1')
    url.searchParams.set('brand_category', category)
    url.searchParams.set('api_url', apiUrl)
    if (shopDomain) url.searchParams.set('shop', shopDomain)
    if (!shopDomain && brandKey) url.searchParams.set('brand_key', brandKey)
    return url.toString()
  }

  // Adds the widget button, modal shell, and iframe styles to the brand page.
  function injectStyles() {
    if (document.getElementById('alphamark-shopify-widget-styles')) return

    const style = document.createElement('style')
    style.id = 'alphamark-shopify-widget-styles'
    style.textContent = `
      .alphamark-widget-button {
        position: fixed !important;
        ${position.includes('left') ? 'left: 22px;' : 'right: 22px;'}
        ${position.includes('top') ? 'top: 22px;' : 'bottom: 22px;'}
        z-index: 2147483000 !important;
        transform: none !important;
        border: 0;
        border-radius: 999px;
        background: linear-gradient(135deg, ${accentColor}, #0f6f63);
        color: #fff;
        box-shadow: 0 18px 44px rgba(0,0,0,.24);
        cursor: pointer;
        font: 700 13px/1.2 Arial, sans-serif;
        letter-spacing: .02em;
        padding: 12px 18px 12px 13px;
        display: inline-flex;
        align-items: center;
        gap: 10px;
        overflow: hidden;
        isolation: isolate;
        transition: transform .2s ease, box-shadow .2s ease;
      }
      .alphamark-widget-button::before {
        content: '';
        position: absolute;
        inset: -40%;
        background: linear-gradient(110deg, transparent 0%, rgba(255,255,255,.35) 46%, transparent 60%);
        transform: translateX(-80%);
        animation: alphamark-shine 4s ease-in-out infinite;
        z-index: -1;
      }
      .alphamark-widget-button:hover {
        transform: translateY(-2px) !important;
        box-shadow: 0 22px 54px rgba(0,0,0,.28);
      }
      .alphamark-widget-button-icon {
        width: 30px;
        height: 30px;
        border-radius: 999px;
        background: rgba(255,255,255,.18);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font: 800 10px/1 Arial, sans-serif;
        box-shadow: inset 0 0 0 1px rgba(255,255,255,.18);
        flex: 0 0 auto;
      }
      .alphamark-widget-button-copy {
        display: inline-flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
      }
      .alphamark-widget-button-label {
        white-space: nowrap;
      }
      .alphamark-widget-button-sub {
        font: 700 9px/1 Arial, sans-serif;
        letter-spacing: .12em;
        text-transform: uppercase;
        opacity: .72;
      }
      @keyframes alphamark-shine {
        0%, 55% { transform: translateX(-80%); }
        80%, 100% { transform: translateX(80%); }
      }
      .alphamark-widget-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483001;
        display: none;
        background: rgba(10, 18, 14, .58);
      }
      .alphamark-widget-overlay.is-open {
        display: block;
      }
      .alphamark-widget-frame {
        width: 100%;
        height: 100%;
        border: 0;
        background: transparent;
      }
      @media (max-width: 640px) {
        .alphamark-widget-button {
          left: 16px;
          right: 16px;
          bottom: 16px;
          width: calc(100% - 32px);
        }
      }
    `
    document.head.appendChild(style)
  }

  // Creates the floating call-to-action button shown on the Shopify storefront.
  function createButton() {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'alphamark-widget-button'
    const icon = document.createElement('span')
    icon.className = 'alphamark-widget-button-icon'
    icon.textContent = 'AI'
    const copy = document.createElement('span')
    copy.className = 'alphamark-widget-button-copy'
    const label = document.createElement('span')
    label.className = 'alphamark-widget-button-label'
    label.textContent = buttonText
    const sub = document.createElement('span')
    sub.className = 'alphamark-widget-button-sub'
    sub.textContent = 'Product match'
    copy.append(label, sub)
    button.append(icon, copy)
    button.addEventListener('click', openWidget)
    document.body.appendChild(button)
  }

  // Resolves the installed Shopify shop to its store-specific widget config.
  async function resolveShopBrandConfig() {
    if (!shopDomain) return

    try {
      const response = await fetch(`${apiUrl}/api/shopify/brand-config?shop=${encodeURIComponent(shopDomain)}`)
      const data = await response.json()

      if (!data.success) return

      category = data.brand_category || category
      accentColor = data.primary_color || accentColor
    } catch (error) {
      console.warn('AlphaMark could not resolve Shopify brand config:', error)
    }
  }

  // Creates the full-screen overlay that will hold the AlphaMark iframe.
  function createOverlay() {
    const overlay = document.createElement('div')
    overlay.className = 'alphamark-widget-overlay'
    overlay.id = 'alphamark-widget-overlay'
    document.body.appendChild(overlay)
  }

  // Opens the modal and lazily loads the iframe only when the user clicks.
  function openWidget() {
    const overlay = document.getElementById('alphamark-widget-overlay')
    if (!overlay) return

    if (!overlay.querySelector('iframe')) {
      const frame = document.createElement('iframe')
      frame.className = 'alphamark-widget-frame'
      frame.title = 'AlphaMark AI Recommendation Widget'
      frame.allow = 'camera; clipboard-write'
      frame.src = widgetUrl()
      overlay.appendChild(frame)
    }

    overlay.classList.add('is-open')
  }

  // Closes the iframe modal when the embedded widget asks the parent page to close it.
  function closeWidget() {
    const overlay = document.getElementById('alphamark-widget-overlay')
    if (overlay) overlay.classList.remove('is-open')
  }

  // Listens for close messages posted by the embedded widget page.
  function listenForWidgetMessages() {
    window.addEventListener('message', event => {
      if (event.origin !== apiUrl) return
      if (event.data?.type === 'alphamark:close') closeWidget()
    })
  }

  // Boots the storefront integration once the document body is ready.
  async function init() {
    await resolveShopBrandConfig()

    if (!brandKey && !shopDomain) {
      console.warn('AlphaMark widget missing data-brand-key or data-shop-domain.')
    }

    injectStyles()
    createButton()
    createOverlay()
    listenForWidgetMessages()
  }

  if (document.body) {
    init()
  } else {
    document.addEventListener('DOMContentLoaded', init)
  }
})()
