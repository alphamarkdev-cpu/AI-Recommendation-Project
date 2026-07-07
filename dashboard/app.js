const state = {
  apiKey: '',
  context: null,
  selectedStoreId: 'all',
  page: 'overview',
  charts: {}
}

const pageTitles = {
  overview: 'Overview',
  products: 'Product Management',
  questions: 'Questions',
  customers: 'Customer Analytics',
  recommendations: 'Recommendation Analytics',
  revenue: 'Revenue Dashboard',
  aiusage: 'AI Usage Dashboard'
}

function q(selector) {
  return document.querySelector(selector)
}

function money(value) {
  return '$' + Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

function percent(value) {
  return Number(value || 0).toFixed(Number(value) % 1 ? 1 : 0) + '%'
}

function number(value) {
  return Number(value || 0).toLocaleString()
}

function getApiKey() {
  const url = new URL(window.location.href)
  const apiKey = url.searchParams.get('api_key') || localStorage.getItem('alpha_api_key') || ''
  if (apiKey) localStorage.setItem('alpha_api_key', apiKey)
  return apiKey
}

async function apiGet(path) {
  const params = new URLSearchParams()
  if (state.selectedStoreId && state.selectedStoreId !== 'all') params.set('store_id', state.selectedStoreId)
  const suffix = params.toString() ? '?' + params.toString() : ''
  const res = await fetch(path + suffix, { headers: { 'x-api-key': state.apiKey } })
  if (!res.ok) throw new Error(`Request failed: ${res.status}`)
  return res.json()
}

function hashString(input) {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return hash >>> 0
}

function seeded(seedText) {
  let seed = hashString(seedText) || 1
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
}

function randInt(rand, min, max) {
  return Math.floor(rand() * (max - min + 1)) + min
}

function lastDays(days) {
  const labels = []
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date()
    date.setDate(date.getDate() - i)
    labels.push(date.toISOString().slice(0, 10))
  }
  return labels
}

function makeTrend(rand, days, min, max, drift = 0) {
  let current = randInt(rand, min, max)
  return lastDays(days).map(date => {
    current = Math.max(min, Math.round(current + randInt(rand, -max * 0.12, max * 0.16) + drift))
    return { date, value: current }
  })
}

function normalizeStore(store, index) {
  return {
    id: store.id || store.store_id || `store_${index + 1}`,
    shop_domain: store.shop_domain || store.domain || `store-${index + 1}.myshopify.com`,
    product_category: store.product_category,
    uninstalled_at: store.uninstalled_at
  }
}

function fallbackContext() {
  return {
    success: true,
    brand: {
      id: 'demo-brand',
      name: 'AlphaMark Demo',
      slug: 'alphamark-demo',
      category: 'Skincare',
      primary_color: '#2563eb'
    },
    selected_store_id: 'all',
    stores: [
      { id: 'demo-store-1', shop_domain: 'glow-house.myshopify.com', product_category: 'Skincare' },
      { id: 'demo-store-2', shop_domain: 'daily-hair-lab.myshopify.com', product_category: 'Hair Care' },
      { id: 'demo-store-3', shop_domain: 'wellness-stack.myshopify.com', product_category: 'Supplements' }
    ]
  }
}

function selectedStore() {
  return (state.context?.stores || []).find(store => store.id === state.selectedStoreId) || null
}

function brandContext() {
  const base = state.context?.brand || fallbackContext().brand
  const store = selectedStore()
  const category = store?.product_category || base.category || base.product_category || 'General'
  const name = base.name || store?.shop_domain?.replace('.myshopify.com', '') || 'Current Brand'
  return {
    id: base.id || base.brand_id || base.slug || name,
    name,
    category,
    primary_color: base.primary_color || '#2563eb',
    scopeName: state.selectedStoreId === 'all' ? 'All Stores' : store?.shop_domain || 'Selected Store'
  }
}

function scopedSeed(page) {
  const brand = brandContext()
  return `${brand.id}:${brand.name}:${state.selectedStoreId}:${page}`
}

function buildDemoData(page) {
  const brand = brandContext()
  const rand = seeded(scopedSeed(page))
  const storeCount = Math.max(1, state.selectedStoreId === 'all'
    ? (state.context?.stores || []).filter(store => !store.uninstalled_at).length || 1
    : 1)
  const productBase = randInt(rand, 80, 520) * storeCount
  const monthlyRecommendations = randInt(rand, 1800, 9800) * storeCount
  const todayRecommendations = randInt(rand, 42, 420) * storeCount
  const orders = randInt(rand, 120, 900) * storeCount
  const revenueGenerated = orders * randInt(rand, 34, 122)
  const revenueInfluenced = Math.round(revenueGenerated * (randInt(rand, 22, 48) / 100))
  const conversionRate = Math.round((orders / monthlyRecommendations) * 1000) / 10
  const overview = {
    total_active_stores: storeCount,
    total_products_synced: productBase,
    todays_recommendations: todayRecommendations,
    monthly_recommendations: monthlyRecommendations,
    recommendation_conversion_rate: conversionRate,
    revenue_influenced: revenueInfluenced,
    active_users_today: randInt(rand, 28, 260) * storeCount
  }

  if (page === 'overview') {
    return {
      success: true,
      brand,
      stores: state.context?.stores || [],
      selected_store_id: state.selectedStoreId,
      kpis: overview,
      charts: {
        revenue_trend: makeTrend(rand, 14, 900, 6500, 80),
        recommendation_trend: makeTrend(rand, 14, 45, 650, 8)
      }
    }
  }

  if (page === 'products') {
    const types = ['Serum', 'Cleanser', 'Moisturizer', 'Mask', 'Treatment', 'Bundle', 'Spray', 'Capsules']
    const statuses = ['Synced', 'Needs Metadata', 'Ready', 'Image Missing', 'Tag Review']
    const products = Array.from({ length: 12 }, (_, index) => {
      const name = `${brand.name} ${types[index % types.length]} ${index + 1}`
      const status = statuses[randInt(rand, 0, statuses.length - 1)]
      const hasImage = status !== 'Image Missing'
      const matchTagCount = randInt(rand, 2, 7)
      return {
        product_id: `${brand.id}-${state.selectedStoreId}-product-${index + 1}`,
        name,
        vendor: brand.name,
        category: brand.category,
        status,
        image_url: hasImage ? `https://picsum.photos/seed/${encodeURIComponent(name)}/96/96` : '',
        product_url: '#',
        description: status === 'Needs Metadata' ? '' : `AI metadata for ${name}`,
        variants_count: randInt(rand, 1, 6),
        match_tags: Array.from({ length: matchTagCount }, (_, tagIndex) => `${brand.category} tag ${tagIndex + 1}`),
        suitable_customer_attributes: ['high-intent', brand.category.toLowerCase(), 'guided']
      }
    })
    return {
      success: true,
      brand,
      kpis: {
        products_synced: productBase,
        ai_metadata: products.filter(product => product.description).length,
        product_images: products.filter(product => product.image_url).length,
        variants: products.reduce((sum, product) => sum + product.variants_count, 0),
        match_tags: products.reduce((sum, product) => sum + product.match_tags.length, 0)
      },
      products
    }
  }

  if (page === 'questions') {
    const questions = [
      `What is your main ${brand.category.toLowerCase()} goal?`,
      'Which result matters most right now?',
      'How sensitive is your routine to new products?',
      'What budget range should the advisor prioritize?',
      'Do you prefer a simple or complete routine?'
    ]
    const flows = Array.from({ length: 3 }, (_, index) => ({
      flow_id: `${brand.id}-flow-${index + 1}`,
      category: brand.category,
      version: 3 - index,
      is_active: index === 0,
      updated_at: lastDays(8 + index * 5)[0],
      questions_json: questions.map((text, questionIndex) => ({ id: `q${questionIndex + 1}`, question_text: text }))
    }))
    return { success: true, brand, flows, active_flow: flows[0] }
  }

  if (page === 'customers') {
    const sessions = makeTrend(rand, 30, 18, 260, 3)
    const totalSessions = sessions.reduce((sum, item) => sum + item.value, 0)
    const completed = Math.round(totalSessions * (randInt(rand, 58, 82) / 100))
    return {
      success: true,
      brand,
      kpis: {
        total_sessions: totalSessions,
        completed_sessions: completed,
        image_upload_percent: randInt(rand, 18, 64),
        clarification_percent: randInt(rand, 12, 38),
        recommendation_percent: Math.round((completed / totalSessions) * 1000) / 10,
        purchase_percent: randInt(rand, 4, 16),
        average_session_time: `${randInt(rand, 2, 6)}m ${randInt(rand, 5, 55)}s`
      },
      trend: sessions
    }
  }

  if (page === 'recommendations') {
    const trend = makeTrend(rand, 30, 40, 520, 6)
    const generated = trend.reduce((sum, item) => sum + item.value, 0)
    const concerns = ['Dryness', 'Breakouts', 'Frizz', 'Dullness', 'Energy', 'Sensitive Skin']
    const top = Array.from({ length: 6 }, (_, index) => ({
      product_id: `${brand.id}-top-${index + 1}`,
      name: `${brand.name} Recommended Product ${index + 1}`,
      image_url: `https://picsum.photos/seed/${encodeURIComponent(brand.name + index)}/96/96`,
      recommendation_count: randInt(rand, 80, 680)
    })).sort((a, b) => b.recommendation_count - a.recommendation_count)
    return {
      success: true,
      brand,
      kpis: {
        recommendations_generated: generated,
        products_recommended: randInt(rand, 24, 180),
        most_selected_concern: concerns[randInt(rand, 0, concerns.length - 1)]
      },
      top_recommended_products: top,
      trend
    }
  }

  if (page === 'revenue') {
    const revenueTrend = makeTrend(rand, 30, 900, 8200, 110)
    const conversionTrend = makeTrend(rand, 30, 3, 18, 0)
    const recommendationTrend = makeTrend(rand, 30, 45, 620, 6)
    const totalRevenue = revenueTrend.reduce((sum, item) => sum + item.value, 0)
    const recommendations = recommendationTrend.reduce((sum, item) => sum + item.value, 0)
    return {
      success: true,
      brand,
      kpis: {
        revenue_generated: totalRevenue,
        revenue_influenced: Math.round(totalRevenue * (randInt(rand, 24, 46) / 100)),
        conversion_percent: conversionRate,
        aov: Math.round(totalRevenue / orders),
        orders,
        recommendations,
        revenue_per_recommendation: Math.round((totalRevenue / recommendations) * 100) / 100
      },
      charts: { revenue_trend: revenueTrend, conversion_trend: conversionTrend, recommendation_trend: recommendationTrend }
    }
  }

  const aiRequests = randInt(rand, 1800, 12000)
  const successPercent = randInt(rand, 94, 99)
  return {
    success: true,
    brand,
    kpis: {
      ai_requests: aiRequests,
      question_generation_calls: Math.round(aiRequests * 0.12),
      recommendation_calls: Math.round(aiRequests * 0.74),
      average_tokens: randInt(rand, 620, 1800),
      monthly_cost: Math.round(aiRequests * randInt(rand, 2, 9) / 100),
      average_response_time: randInt(rand, 420, 1450),
      success_percent: successPercent,
      failure_percent: Math.round((100 - successPercent) * 10) / 10
    },
    trend: makeTrend(rand, 30, 40, 480, 4)
  }
}

function setText(id, value) {
  const el = q(id)
  if (el) el.textContent = value
}

function setBrandHeader(data) {
  const brand = data.brand || brandContext()
  setText('#brandMeta', `${brand.name} - ${brand.category} - ${brand.scopeName || brandContext().scopeName}`)
}

function updateTopKpis(data) {
  const brand = data.brand || brandContext()
  const kpis = data.kpis || {}
  setText('#k_brandName', brand.name)
  setText('#k_brandCategory', brand.category)
  setText('#k_activeStores', number(kpis.total_active_stores ?? 0))
  setText('#k_productsSynced', number(kpis.total_products_synced ?? kpis.products_synced ?? 0))
  setText('#k_todayRec', number(kpis.todays_recommendations ?? 0))
  setText('#k_monthRec', number(kpis.monthly_recommendations ?? 0))
  setText('#k_convRate', percent(kpis.recommendation_conversion_rate ?? kpis.conversion_percent ?? 0))
  setText('#k_revenueInfluenced', money(kpis.revenue_influenced ?? 0))
  setText('#k_activeUsers', number(kpis.active_users_today ?? 0))
  setBrandHeader(data)
}

function destroyChart(id) {
  if (state.charts[id]) state.charts[id].destroy()
}

function drawChart(id, type, labels, values, label, color) {
  const canvas = q('#' + id)
  if (!canvas) return
  destroyChart(id)
  state.charts[id] = new Chart(canvas.getContext('2d'), {
    type,
    data: {
      labels,
      datasets: [{
        label,
        data: values,
        borderColor: color,
        backgroundColor: type === 'bar' ? color : color + '22',
        tension: 0.35,
        borderWidth: 2,
        fill: type !== 'bar'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true }, x: { ticks: { maxTicksLimit: 7 } } }
    }
  })
}

function metricCard(label, value) {
  return `<div class="metric-card"><span>${label}</span><strong>${value}</strong></div>`
}

function renderOverview(data = buildDemoData('overview')) {
  q('#overviewPage').style.display = ''
  q('#contentArea').innerHTML = ''
  updateTopKpis(data)
  const revenue = data.charts.revenue_trend || []
  const recommendations = data.charts.recommendation_trend || []
  drawChart('revenueChart', 'line', revenue.map(item => item.date), revenue.map(item => item.value), 'Revenue Influenced', '#2563eb')
  drawChart('recChart', 'bar', recommendations.map(item => item.date), recommendations.map(item => item.value), 'Recommendations', '#0f766e')
}

function renderProducts(data = buildDemoData('products')) {
  q('#overviewPage').style.display = 'none'
  updateTopKpis({ ...buildDemoData('overview'), brand: data.brand })
  const k = data.kpis
  const rows = data.products.map(product => `
    <tr>
      <td>
        <div class="product-cell">
          ${product.image_url ? `<img src="${product.image_url}" alt="">` : '<div class="image-placeholder">IMG</div>'}
          <div><strong>${product.name}</strong><span>${product.vendor} - ${product.category}</span></div>
        </div>
      </td>
      <td>${product.variants_count}</td>
      <td>${product.match_tags.slice(0, 3).map(tag => `<span class="tag">${tag}</span>`).join('')}</td>
      <td><span class="status">${product.status}</span></td>
      <td class="actions">
        <a href="${product.product_url}" target="_blank">View Product</a>
        <button data-action="edit-meta" data-id="${product.product_id}">Edit Metadata</button>
      </td>
    </tr>
  `).join('')

  q('#contentArea').innerHTML = `
    <section class="panel">
      <div class="section-head">
        <div><h3>Product Management</h3><p>${data.brand.name} catalog health and AI enrichment status.</p></div>
        <div class="button-row">
          <button data-demo-action="sync">Sync Products</button>
          <button data-demo-action="metadata">Regenerate Metadata</button>
        </div>
      </div>
      <div class="metrics-grid">
        ${metricCard('Products Synced', number(k.products_synced))}
        ${metricCard('AI Metadata', number(k.ai_metadata))}
        ${metricCard('Product Images', number(k.product_images))}
        ${metricCard('Variants', number(k.variants))}
        ${metricCard('Match Tags', number(k.match_tags))}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Product</th><th>Variants</th><th>Match Tags</th><th>Status</th><th>Buttons</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `
  bindDemoButtons()
}

function renderQuestions(data = buildDemoData('questions')) {
  q('#overviewPage').style.display = 'none'
  updateTopKpis({ ...buildDemoData('overview'), brand: data.brand })
  const active = data.active_flow
  q('#contentArea').innerHTML = `
    <section class="panel">
      <div class="section-head">
        <div><h3>${data.brand.name}</h3><p>Active question flow for ${data.brand.category} recommendations.</p></div>
        <div class="button-row">
          <button data-demo-action="view-questions">View Questions</button>
          <button data-demo-action="regen-questions">Regenerate Questions</button>
          <button data-demo-action="edit-questions">Edit Questions</button>
          <button data-demo-action="preview-flow">Preview Flow</button>
        </div>
      </div>
      <div class="flow-preview">
        ${(active?.questions_json || []).map((question, index) => `
          <div class="question-row"><span>${index + 1}</span><strong>${question.question_text}</strong></div>
        `).join('')}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Flow</th><th>Category</th><th>Status</th><th>Updated</th></tr></thead>
          <tbody>${data.flows.map(flow => `
            <tr><td>Version ${flow.version}</td><td>${flow.category}</td><td><span class="status">${flow.is_active ? 'Active' : 'Draft'}</span></td><td>${flow.updated_at}</td></tr>
          `).join('')}</tbody>
        </table>
      </div>
    </section>
  `
  bindDemoButtons()
}

function renderCustomers(data = buildDemoData('customers')) {
  q('#overviewPage').style.display = 'none'
  updateTopKpis({ ...buildDemoData('overview'), brand: data.brand })
  const k = data.kpis
  q('#contentArea').innerHTML = `
    <section class="panel">
      <div class="section-head"><div><h3>Customer Analytics</h3><p>Session behavior and funnel completion for ${data.brand.name}.</p></div></div>
      <div class="metrics-grid">
        ${metricCard('Total Sessions', number(k.total_sessions))}
        ${metricCard('Completed Sessions', number(k.completed_sessions))}
        ${metricCard('Image Upload %', percent(k.image_upload_percent))}
        ${metricCard('Clarification %', percent(k.clarification_percent))}
        ${metricCard('Recommendation %', percent(k.recommendation_percent))}
        ${metricCard('Purchase %', percent(k.purchase_percent))}
        ${metricCard('Average Session Time', k.average_session_time)}
      </div>
      <div class="chart-box"><canvas id="customerTrend"></canvas></div>
    </section>
  `
  drawChart('customerTrend', 'line', data.trend.map(item => item.date), data.trend.map(item => item.value), 'Sessions', '#16a34a')
}

function renderRecommendations(data = buildDemoData('recommendations')) {
  q('#overviewPage').style.display = 'none'
  updateTopKpis({ ...buildDemoData('overview'), brand: data.brand })
  const k = data.kpis
  q('#contentArea').innerHTML = `
    <section class="panel">
      <div class="section-head"><div><h3>Recommendation Analytics</h3><p>Products and customer concerns driving recommendation outcomes.</p></div></div>
      <div class="metrics-grid">
        ${metricCard('Recommendations Generated', number(k.recommendations_generated))}
        ${metricCard('Products Recommended', number(k.products_recommended))}
        ${metricCard('Most Selected Concern', k.most_selected_concern)}
      </div>
      <div class="split-grid">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Top Recommended Products</th><th>Recommendations</th></tr></thead>
            <tbody>${data.top_recommended_products.map(product => `
              <tr>
                <td><div class="product-cell"><img src="${product.image_url}" alt=""><strong>${product.name}</strong></div></td>
                <td>${number(product.recommendation_count)}</td>
              </tr>
            `).join('')}</tbody>
          </table>
        </div>
        <div class="chart-box"><canvas id="recommendationTrend"></canvas></div>
      </div>
    </section>
  `
  drawChart('recommendationTrend', 'line', data.trend.map(item => item.date), data.trend.map(item => item.value), 'Recommendations', '#7c3aed')
}

function renderRevenue(data = buildDemoData('revenue')) {
  q('#overviewPage').style.display = 'none'
  updateTopKpis({ ...buildDemoData('overview'), brand: data.brand })
  const k = data.kpis
  q('#contentArea').innerHTML = `
    <section class="panel">
      <div class="section-head"><div><h3>Revenue Dashboard</h3><p>Revenue, orders, and conversion trends influenced by recommendations.</p></div></div>
      <div class="metrics-grid">
        ${metricCard('Revenue Generated', money(k.revenue_generated))}
        ${metricCard('Revenue Influenced', money(k.revenue_influenced))}
        ${metricCard('Conversion %', percent(k.conversion_percent))}
        ${metricCard('AOV', money(k.aov))}
        ${metricCard('Orders', number(k.orders))}
        ${metricCard('Recommendations', number(k.recommendations))}
        ${metricCard('Revenue per Recommendation', money(k.revenue_per_recommendation))}
      </div>
      <div class="three-charts">
        <div class="chart-box"><h4>Revenue Trend</h4><canvas id="revenueTrend"></canvas></div>
        <div class="chart-box"><h4>Conversion Trend</h4><canvas id="conversionTrend"></canvas></div>
        <div class="chart-box"><h4>Recommendation Trend</h4><canvas id="revenueRecommendationTrend"></canvas></div>
      </div>
    </section>
  `
  drawChart('revenueTrend', 'line', data.charts.revenue_trend.map(item => item.date), data.charts.revenue_trend.map(item => item.value), 'Revenue', '#ea580c')
  drawChart('conversionTrend', 'line', data.charts.conversion_trend.map(item => item.date), data.charts.conversion_trend.map(item => item.value), 'Conversion', '#dc2626')
  drawChart('revenueRecommendationTrend', 'bar', data.charts.recommendation_trend.map(item => item.date), data.charts.recommendation_trend.map(item => item.value), 'Recommendations', '#0891b2')
}

function renderAIUsage(data = buildDemoData('aiusage')) {
  q('#overviewPage').style.display = 'none'
  updateTopKpis({ ...buildDemoData('overview'), brand: data.brand })
  const k = data.kpis
  q('#contentArea').innerHTML = `
    <section class="panel">
      <div class="section-head"><div><h3>AI Usage Dashboard</h3><p>Model activity, cost, latency, and reliability for ${data.brand.name}.</p></div></div>
      <div class="metrics-grid">
        ${metricCard('AI Requests', number(k.ai_requests))}
        ${metricCard('Question Generation Calls', number(k.question_generation_calls))}
        ${metricCard('Recommendation Calls', number(k.recommendation_calls))}
        ${metricCard('Average Tokens', number(k.average_tokens))}
        ${metricCard('Monthly Cost', money(k.monthly_cost))}
        ${metricCard('Average Response Time', `${number(k.average_response_time)} ms`)}
        ${metricCard('Success %', percent(k.success_percent))}
        ${metricCard('Failure %', percent(k.failure_percent))}
      </div>
      <div class="chart-box"><canvas id="aiUsageTrend"></canvas></div>
    </section>
  `
  drawChart('aiUsageTrend', 'line', data.trend.map(item => item.date), data.trend.map(item => item.value), 'AI Requests', '#4f46e5')
}

function bindDemoButtons() {
  document.querySelectorAll('[data-demo-action], [data-action]').forEach(button => {
    button.addEventListener('click', event => {
      event.preventDefault()
      const action = button.getAttribute('data-demo-action') || button.getAttribute('data-action')
      alert(`${button.textContent.trim()} is connected in demo mode for ${brandContext().name}. Action: ${action}.`)
    })
  })
}

function renderPage(page = state.page) {
  state.page = page
  q('#pageTitle').textContent = pageTitles[page]
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-page') === page)
  })

  if (page === 'overview') renderOverview(buildDemoData('overview'))
  if (page === 'products') renderProducts(buildDemoData('products'))
  if (page === 'questions') renderQuestions(buildDemoData('questions'))
  if (page === 'customers') renderCustomers(buildDemoData('customers'))
  if (page === 'recommendations') renderRecommendations(buildDemoData('recommendations'))
  if (page === 'revenue') renderRevenue(buildDemoData('revenue'))
  if (page === 'aiusage') renderAIUsage(buildDemoData('aiusage'))
}

function populateStoreSelect() {
  const select = q('#brandSelect')
  select.innerHTML = ''
  const all = document.createElement('option')
  all.value = 'all'
  all.textContent = 'All Stores'
  select.appendChild(all)

  ;(state.context?.stores || []).forEach(store => {
    const option = document.createElement('option')
    option.value = store.id
    option.textContent = store.shop_domain
    select.appendChild(option)
  })

  select.value = state.selectedStoreId
}

async function loadContext() {
  state.apiKey = getApiKey()
  try {
    const overview = await apiGet('/api/dashboard/overview')
    const fallback = fallbackContext()
    const stores = (overview.stores && overview.stores.length ? overview.stores : fallback.stores).map(normalizeStore)
    state.context = {
      ...overview,
      brand: {
        ...fallback.brand,
        ...overview.brand,
        id: overview.brand?.id || overview.brand?.brand_id || overview.brand?.slug || fallback.brand.id,
        category: overview.brand?.category || overview.brand?.product_category || fallback.brand.category
      },
      stores
    }
    state.selectedStoreId = overview.selected_store_id || 'all'
  } catch (error) {
    console.warn('Dashboard API unavailable. Using local demo context.', error)
    state.context = fallbackContext()
    state.selectedStoreId = 'all'
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadContext()
  populateStoreSelect()
  renderPage('overview')

  q('#brandSelect').addEventListener('change', event => {
    state.selectedStoreId = event.target.value
    renderPage(state.page)
  })

  document.querySelectorAll('.nav-btn').forEach(button => {
    button.addEventListener('click', () => renderPage(button.getAttribute('data-page')))
  })

  q('#syncBtn').addEventListener('click', () => alert(`Sync Products is in demo mode for ${brandContext().scopeName}.`))
  q('#regenBtn').addEventListener('click', () => {
    if (state.page === 'questions') renderQuestions(buildDemoData('questions'))
    else if (state.page === 'products') renderProducts(buildDemoData('products'))
    else alert(`Regenerate is in demo mode for ${pageTitles[state.page]}.`)
  })
})
