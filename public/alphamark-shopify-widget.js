(function () {
  const script = document.currentScript
  const apiUrl = (script?.dataset.apiUrl || new URL(script.src).origin).replace(/\/$/, '')
  const brandKey = script?.dataset.brandKey || ''
  const category = script?.dataset.category || 'skincare'
  const buttonText = script?.dataset.buttonText || 'Test Your Skin'
  const accentColor = script?.dataset.accentColor || '#1B4332'
  const position = script?.dataset.position || 'bottom-right'

  // Builds a URL for the iframe-hosted AlphaMark widget with brand-specific settings.
  function widgetUrl() {
    const url = new URL('/widget', apiUrl)
    url.searchParams.set('embed', '1')
    url.searchParams.set('brand_key', brandKey)
    url.searchParams.set('brand_category', category)
    url.searchParams.set('api_url', apiUrl)
    return url.toString()
  }

  // Adds the widget button, modal shell, and iframe styles to the brand page.
  function injectStyles() {
    if (document.getElementById('alphamark-shopify-widget-styles')) return

    const style = document.createElement('style')
    style.id = 'alphamark-shopify-widget-styles'
    style.textContent = `
      .alphamark-widget-button {
        position: fixed;
        ${position.includes('left') ? 'left: 22px;' : 'right: 22px;'}
        ${position.includes('top') ? 'top: 22px;' : 'bottom: 22px;'}
        z-index: 2147483000;
        border: 0;
        border-radius: 999px;
        background: ${accentColor};
        color: #fff;
        box-shadow: 0 12px 34px rgba(0,0,0,.22);
        cursor: pointer;
        font: 700 13px/1.2 Arial, sans-serif;
        letter-spacing: .02em;
        padding: 14px 20px;
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
    button.textContent = buttonText
    button.addEventListener('click', openWidget)
    document.body.appendChild(button)
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
  function init() {
    if (!brandKey) {
      console.warn('AlphaMark widget missing data-brand-key.')
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
