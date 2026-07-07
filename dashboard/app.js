function getApiKey() {
  const url = new URL(window.location.href)
  const apiKey = url.searchParams.get('api_key') || localStorage.getItem('alpha_api_key') || ''
  if (apiKey) localStorage.setItem('alpha_api_key', apiKey)
  return apiKey
}

async function fetchOverview() {
  const apiKey = getApiKey()
  const res = await fetch('/api/dashboard/overview', { headers: { 'x-api-key': apiKey } })
  return await res.json()
}

function q(sel){return document.querySelector(sel)}

function updateTopKpis(kpis = {}, brand = {}){
  if (brand.name) q('#k_brandName').textContent = brand.name
  if (brand.category) q('#k_brandCategory').textContent = brand.category
  q('#k_activeStores').textContent = kpis.total_active_stores ?? kpis.products_synced ?? 0
  q('#k_productsSynced').textContent = kpis.total_products_synced ?? kpis.products_synced ?? 0
  q('#k_todayRec').textContent = kpis.todays_recommendations ?? kpis.completed_sessions ?? 0
  q('#k_monthRec').textContent = kpis.monthly_recommendations ?? kpis.product_images ?? kpis.monthly_recommendations ?? 0
  q('#k_convRate').textContent = (kpis.recommendation_conversion_rate ?? kpis.conversion_percent ?? 0) + '%'
  q('#k_activeUsers').textContent = kpis.active_users_today ?? kpis.active_sessions ?? 0
}

function renderOverview(brand){
  q('#k_brandName').textContent = brand.name;
  q('#k_brandCategory').textContent = brand.category;
  q('#k_activeStores').textContent = brand.activeStores;
  q('#k_productsSynced').textContent = brand.productsSynced;
  q('#k_todayRec').textContent = brand.todayRecommendations;
  q('#k_monthRec').textContent = brand.monthlyRecommendations;
  q('#k_convRate').textContent = brand.conversionRate + '%';
  q('#k_activeUsers').textContent = brand.activeUsersToday;

  // charts
  const revenueCtx = q('#revenueChart').getContext('2d');
  window._revChart && window._revChart.destroy();
  window._revChart = new Chart(revenueCtx, {
    type: 'line',
    data: { labels: ['-6d','-5d','-4d','-3d','-2d','-1d','today'], datasets:[{label:'Revenue',data:brand.revenue, borderColor:'#4F46E5', backgroundColor:'rgba(79,70,229,0.06)'}]}
  });

  const recCtx = q('#recChart').getContext('2d');
  window._recChart && window._recChart.destroy();
  window._recChart = new Chart(recCtx, {
    type: 'bar',
    data: { labels: ['-6d','-5d','-4d','-3d','-2d','-1d','today'], datasets:[{label:'Recommendations',data:brand.recommendationTrend, backgroundColor:'#06B6D4'}]}
  });
}

function renderProducts(apiResponse){
  updateTopKpis(apiResponse.kpis || {}, apiResponse.brand || {})
  const kpis = apiResponse.kpis || {}
  const products = apiResponse.products || []
  const el = document.createElement('div')
  el.className = 'space-y-4'

  const header = document.createElement('div')
  header.className = 'card p-4'
  header.innerHTML = `
    <div class="flex items-center justify-between mb-2">
      <h3 class="font-semibold">Product Management</h3>
      <div class="space-x-2">
        <button id="syncProductsBtn" class="px-3 py-1 bg-indigo-600 text-white rounded">Sync Products</button>
        <button id="regenMetaBtn" class="px-3 py-1 border rounded">Regenerate Metadata</button>
      </div>
    </div>
    <div class="grid grid-cols-3 gap-4 text-sm text-gray-600">
      <div>Products Synced: <strong>${kpis.products_synced ?? 0}</strong></div>
      <div>AI Metadata: <strong>${kpis.ai_metadata ?? 0}</strong></div>
      <div>Product Images: <strong>${kpis.product_images ?? 0}</strong></div>
      <div>Variants: <strong>${kpis.variants ?? 0}</strong></div>
      <div>Match Tags: <strong>${kpis.match_tags ?? 0}</strong></div>
    </div>`

  el.appendChild(header)

  const listCard = document.createElement('div')
  listCard.className = 'card p-4'
  const rows = products.map(p => `
    <div class="flex items-center justify-between border-b py-2">
      <div class="flex items-center space-x-3">
        <img src="${p.image_url || ''}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:6px" />
        <div>
          <div class="font-medium">${p.name}</div>
          <div class="text-sm text-gray-500">${p.vendor || ''} • ${p.category || ''}</div>
        </div>
      </div>
      <div class="space-x-2">
        <a class="px-3 py-1 border rounded text-sm" href="${p.product_url || '#'}" target="_blank">View Product</a>
        <button data-id="${p.product_id}" class="editMetaBtn px-3 py-1 border rounded text-sm">Edit Metadata</button>
      </div>
    </div>`).join('')

  listCard.innerHTML = `<h4 class="font-semibold mb-3">Products</h4>${rows || '<div class="text-sm text-gray-500">No products</div>'}`
  el.appendChild(listCard)

  q('#contentArea').innerHTML = ''
  q('#contentArea').appendChild(el)

  // Hook buttons
  q('#syncProductsBtn').addEventListener('click', async () => {
    const apiKey = getApiKey()
    const resp = await fetch('/shopify/products/sync', { method: 'POST', headers: { 'x-api-key': apiKey } })
    const json = await resp.json()
    alert(json?.message || JSON.stringify(json))
  })

  q('#regenMetaBtn').addEventListener('click', () => {
    alert('Regenerate Metadata endpoint not implemented on server.');
  })

  document.querySelectorAll('.editMetaBtn').forEach(btn => {
    btn.addEventListener('click', (e)=>{
      const id = btn.getAttribute('data-id')
      alert('Open metadata editor for product id: ' + id)
    })
  })
}

function renderQuestions(apiResponse){
  updateTopKpis(apiResponse.kpis || {}, apiResponse.brand || {})
  const flows = apiResponse.flows || []
  const active = apiResponse.active_flow
  const el = document.createElement('div')
  el.className = 'space-y-4'

  const header = document.createElement('div')
  header.className = 'card p-4'
  header.innerHTML = `
    <div class="flex items-center justify-between">
      <h3 class="font-semibold">Questions Design</h3>
      <div class="space-x-2">
        <button id="viewFlowsBtn" class="px-3 py-1 border rounded">View Questions</button>
        <button id="regenFlowsBtn" class="px-3 py-1 border rounded">Regenerate Questions</button>
        <button id="editFlowBtn" class="px-3 py-1 border rounded">Edit Questions</button>
        <button id="previewFlowBtn" class="px-3 py-1 bg-indigo-600 text-white rounded">Preview Flow</button>
      </div>
    </div>
    <div class="text-sm text-gray-600 mt-2">Active flow version: <strong>${active?.version ?? 'N/A'}</strong></div>`

  el.appendChild(header)

  const flowsCard = document.createElement('div')
  flowsCard.className = 'card p-4'
  flowsCard.innerHTML = `<h4 class="font-semibold mb-2">Saved Flows</h4>` + (flows.map(f => `
    <div class="py-2 border-b">
      <div class="text-sm font-medium">Version ${f.version} — ${f.category}</div>
      <div class="text-xs text-gray-500">Updated ${f.updated_at}</div>
    </div>`).join('') || '<div class="text-sm text-gray-500">No flows</div>')

  el.appendChild(flowsCard)
  q('#contentArea').innerHTML = ''
  q('#contentArea').appendChild(el)

  q('#regenFlowsBtn').addEventListener('click', async ()=>{
    const apiKey = getApiKey()
    const r = await fetch('/api/questions/flow/generate', { method: 'POST', headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
    const j = await r.json()
    alert(j.success ? 'Regenerated question flow' : 'Failed: ' + (j.error || JSON.stringify(j)))
  })
}

function renderCustomers(apiResponse){
  updateTopKpis(apiResponse.kpis || {}, apiResponse.brand || {})
  const k = apiResponse.kpis || {}
  const trend = apiResponse.trend || []
  const el = document.createElement('div')
  el.className = 'card p-4'
  el.innerHTML = `
    <h3 class="font-semibold mb-2">Customer Analytics</h3>
    <div class="grid grid-cols-3 gap-4 mb-4">
      <div class="p-3 bg-gray-50 rounded">Total Sessions: <strong>${k.total_sessions ?? 0}</strong></div>
      <div class="p-3 bg-gray-50 rounded">Completed Sessions: <strong>${k.completed_sessions ?? 0}</strong></div>
      <div class="p-3 bg-gray-50 rounded">Image Upload %: <strong>${k.image_upload_percent ?? 0}%</strong></div>
      <div class="p-3 bg-gray-50 rounded">Clarification %: <strong>${k.clarification_percent ?? 0}%</strong></div>
      <div class="p-3 bg-gray-50 rounded">Recommendation %: <strong>${k.recommendation_percent ?? 0}%</strong></div>
      <div class="p-3 bg-gray-50 rounded">Purchase %: <strong>${k.purchase_percent ?? 0}%</strong></div>
      <div class="p-3 bg-gray-50 rounded">Average Session Time: <strong>${k.average_session_time ?? 'N/A'}</strong></div>
    </div>
    <div><canvas id="customerTrend" height="120"></canvas></div>`

  q('#contentArea').innerHTML = ''
  q('#contentArea').appendChild(el)

  const ctx = q('#customerTrend').getContext('2d')
  window._custChart && window._custChart.destroy()
  window._custChart = new Chart(ctx, { type: 'line', data: { labels: trend.map(t=>t.date), datasets:[{ label:'Sessions', data: trend.map(t=>t.value), borderColor:'#10B981', backgroundColor:'rgba(16,185,129,0.06)'}] } })
}

function renderRecommendations(apiResponse){
  updateTopKpis(apiResponse.kpis || {}, apiResponse.brand || {})
  const k = apiResponse.kpis || {}
  const top = apiResponse.top_recommended_products || []
  const trend = apiResponse.trend || []
  const el = document.createElement('div')
  el.className = 'card p-4'
  el.innerHTML = `
    <h3 class="font-semibold mb-2">Recommendation Analytics</h3>
    <div class="grid grid-cols-3 gap-4 mb-4">
      <div class="p-3 bg-gray-50 rounded">Recommendations Generated: <strong>${k.recommendations_generated ?? 0}</strong></div>
      <div class="p-3 bg-gray-50 rounded">Products Recommended: <strong>${k.products_recommended ?? 0}</strong></div>
      <div class="p-3 bg-gray-50 rounded">Most Selected Concern: <strong>${k.most_selected_concern ?? 'N/A'}</strong></div>
    </div>
    <div class="mb-4"><h4 class="font-semibold">Top Recommended Products</h4>${top.map(p=>`<div class="py-2 border-b flex items-center justify-between"><div><img src="${p.image_url||''}" style="width:40px;height:40px;object-fit:cover;border-radius:6px;margin-right:8px"/>${p.name}</div><div class="text-sm text-gray-600">${p.recommendation_count} recs</div></div>`).join('')}</div>
    <div><canvas id="recTrend" height="120"></canvas></div>`

  q('#contentArea').innerHTML = ''
  q('#contentArea').appendChild(el)

  const ctx = q('#recTrend').getContext('2d')
  window._recTrend && window._recTrend.destroy()
  window._recTrend = new Chart(ctx, { type: 'line', data: { labels: trend.map(t=>t.date), datasets:[{ label:'Recommendations', data: trend.map(t=>t.value), borderColor:'#6366F1', backgroundColor:'rgba(99,102,241,0.06)'}] } })
}

function renderRevenue(apiResponse){
  updateTopKpis(apiResponse.kpis || {}, apiResponse.brand || {})
  const k = apiResponse.kpis || {}
  const charts = apiResponse.charts || {}
  const el = document.createElement('div')
  el.className = 'card p-4'
  el.innerHTML = `
    <h3 class="font-semibold mb-2">Revenue Dashboard</h3>
    <div class="grid grid-cols-3 gap-4 mb-4">
      <div class="p-3 bg-gray-50 rounded">Revenue Generated: <strong>$${k.revenue_generated ?? 0}</strong></div>
      <div class="p-3 bg-gray-50 rounded">Revenue Influenced: <strong>$${k.revenue_influenced ?? 0}</strong></div>
      <div class="p-3 bg-gray-50 rounded">Conversion %: <strong>${k.conversion_percent ?? 0}%</strong></div>
      <div class="p-3 bg-gray-50 rounded">AOV: <strong>$${k.aov ?? 0}</strong></div>
      <div class="p-3 bg-gray-50 rounded">Orders: <strong>${k.orders ?? 0}</strong></div>
      <div class="p-3 bg-gray-50 rounded">Recommendations: <strong>${k.recommendations ?? 0}</strong></div>
    </div>
    <div class="grid grid-cols-3 gap-4">
      <div><h4 class="font-semibold">Revenue Trend</h4><canvas id="revTrend" height="100"></canvas></div>
      <div><h4 class="font-semibold">Conversion Trend</h4><canvas id="convTrend" height="100"></canvas></div>
      <div><h4 class="font-semibold">Recommendation Trend</h4><canvas id="recTrend2" height="100"></canvas></div>
    </div>`

  q('#contentArea').innerHTML = ''
  q('#contentArea').appendChild(el)

  const rev = charts.revenue_trend || []
  const conv = charts.conversion_trend || []
  const rec = charts.recommendation_trend || []

  const ctx1 = q('#revTrend').getContext('2d')
  window._revTrend && window._revTrend.destroy()
  window._revTrend = new Chart(ctx1, { type:'line', data: { labels: rev.map(r=>r.date), datasets:[{ label:'Revenue', data: rev.map(r=>r.value), borderColor:'#F59E0B' }] } })

  const ctx2 = q('#convTrend').getContext('2d')
  window._convTrend && window._convTrend.destroy()
  window._convTrend = new Chart(ctx2, { type:'line', data: { labels: conv.map(r=>r.date), datasets:[{ label:'Conversions', data: conv.map(r=>r.value), borderColor:'#EF4444' }] } })

  const ctx3 = q('#recTrend2').getContext('2d')
  window._recTrend2 && window._recTrend2.destroy()
  window._recTrend2 = new Chart(ctx3, { type:'line', data: { labels: rec.map(r=>r.date), datasets:[{ label:'Recommendations', data: rec.map(r=>r.value), borderColor:'#06B6D4' }] } })
}

function renderAIUsage(apiResponse){
  const kpis = apiResponse.kpis || {}
  updateTopKpis(kpis, apiResponse.brand || {})
  const el = document.createElement('div')
  el.className = 'card p-4'
  el.innerHTML = `
    <h3 class="font-semibold mb-2">AI Usage</h3>
    <div class="grid grid-cols-2 gap-4">
      <div class="p-3 bg-gray-50 rounded">AI Requests: <strong>${kpis.ai_requests ?? 0}</strong></div>
      <div class="p-3 bg-gray-50 rounded">Question Generation Calls: <strong>${kpis.question_generation_calls ?? 0}</strong></div>
      <div class="p-3 bg-gray-50 rounded">Recommendation Calls: <strong>${kpis.recommendation_calls ?? 0}</strong></div>
      <div class="p-3 bg-gray-50 rounded">Average Tokens: <strong>${kpis.average_tokens ?? 0}</strong></div>
      <div class="p-3 bg-gray-50 rounded">Monthly Cost: <strong>$${kpis.monthly_cost ?? 0}</strong></div>
      <div class="p-3 bg-gray-50 rounded">Average Response Time: <strong>${kpis.average_response_time ?? 0} ms</strong></div>
      <div class="p-3 bg-gray-50 rounded">Success %: <strong>${kpis.success_percent ?? 0}%</strong></div>
      <div class="p-3 bg-gray-50 rounded">Failure %: <strong>${kpis.failure_percent ?? 0}%</strong></div>
    </div>`
  q('#contentArea').innerHTML = ''
  q('#contentArea').appendChild(el)
}

document.addEventListener('DOMContentLoaded', async ()=>{
  // Fetch overview from backend and populate brand-level UI.
  const payload = await fetchOverview()
  if (!payload || !payload.success) {
    console.error('Failed to load dashboard overview', payload)
    return
  }

  const stores = payload.stores || []
  const sel = q('#brandSelect')
  const allOption = document.createElement('option'); allOption.value = 'all'; allOption.textContent = 'All Stores'; sel.appendChild(allOption)
  stores.forEach(s=>{ const opt = document.createElement('option'); opt.value=s.id; opt.textContent=s.shop_domain; sel.appendChild(opt); })

  function currentStore(){
    const id = sel.value || payload.selected_store_id || 'all'
    return id
  }

  sel.addEventListener('change', async ()=>{
    const storeId = currentStore()
    const apiKey = getApiKey()
    const res = await fetch('/api/dashboard/overview?store_id='+encodeURIComponent(storeId), { headers: { 'x-api-key': apiKey } })
    const data = await res.json()
    if (data && data.success) {
      const b = data.brand
      document.querySelector('#brandMeta').textContent = b.name + ' — ' + b.category
      document.querySelector('#pageTitle').textContent = 'Overview'
      renderOverview({
        name: b.name,
        category: b.category,
        activeStores: data.kpis.total_active_stores,
        productsSynced: data.kpis.total_products_synced,
        todayRecommendations: data.kpis.todays_recommendations,
        monthlyRecommendations: data.kpis.monthly_recommendations,
        conversionRate: data.kpis.recommendation_conversion_rate,
        activeUsersToday: data.kpis.active_users_today,
        revenue: (data.charts && data.charts.revenue_trend) ? data.charts.revenue_trend.map(d=>d.value) : [0,0,0,0,0,0,0],
        recommendationTrend: (data.charts && data.charts.recommendation_trend) ? data.charts.recommendation_trend.map(d=>d.value) : [0,0,0,0,0,0,0]
      })
    }
  })

  // initial render
  const brand = payload.brand
  document.querySelector('#brandMeta').textContent = brand.name + ' — ' + brand.category
  renderOverview({
    name: brand.name,
    category: brand.category,
    activeStores: payload.kpis.total_active_stores,
    productsSynced: payload.kpis.total_products_synced,
    todayRecommendations: payload.kpis.todays_recommendations,
    monthlyRecommendations: payload.kpis.monthly_recommendations,
    conversionRate: payload.kpis.recommendation_conversion_rate,
    activeUsersToday: payload.kpis.active_users_today,
    revenue: (payload.charts && payload.charts.revenue_trend) ? payload.charts.revenue_trend.map(d=>d.value) : [0,0,0,0,0,0,0],
    recommendationTrend: (payload.charts && payload.charts.recommendation_trend) ? payload.charts.recommendation_trend.map(d=>d.value) : [0,0,0,0,0,0,0]
  })
  // ensure hero KPI cards show overview KPIs on initial load
  updateTopKpis(payload.kpis || {}, payload.brand || {})

  // nav - fetch other endpoints when clicked
  function attachNavHandlers(){
    document.querySelectorAll('.nav-btn').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const page = btn.getAttribute('data-page')
        const apiKey = getApiKey()
        document.querySelector('#pageTitle').textContent = btn.textContent.trim()
        const overviewPage = q('#overviewPage')
        if (page === 'overview') overviewPage.style.display = ''
        else overviewPage.style.display = 'none'
        try {
          if (page === 'overview') {
            const res = await fetch('/api/dashboard/overview', { headers: { 'x-api-key': apiKey } })
            const d = await res.json(); if (d.success) { renderOverview({
              name: d.brand.name,
              category: d.brand.category,
              activeStores: d.kpis.total_active_stores,
              productsSynced: d.kpis.total_products_synced,
              todayRecommendations: d.kpis.todays_recommendations,
              monthlyRecommendations: d.kpis.monthly_recommendations,
              conversionRate: d.kpis.recommendation_conversion_rate,
              activeUsersToday: d.kpis.active_users_today,
              revenue: (d.charts && d.charts.revenue_trend) ? d.charts.revenue_trend.map(x=>x.value) : [0,0,0,0,0,0,0],
              recommendationTrend: (d.charts && d.charts.recommendation_trend) ? d.charts.recommendation_trend.map(x=>x.value) : [0,0,0,0,0,0,0]
            })} else { alert('Overview fetch failed: ' + (d.error || JSON.stringify(d))) }
            if (d && d.success) updateTopKpis(d.kpis || {}, d.brand || {})
          }
          if (page === 'products') { const res = await fetch('/api/dashboard/products', { headers: { 'x-api-key': apiKey } }); const d = await res.json(); if (d && !d.brand) d.brand = payload.brand; if (d.success) renderProducts(d); else alert('Products fetch failed: ' + (d.error || JSON.stringify(d))) }
          if (page === 'questions') { const res = await fetch('/api/dashboard/questions', { headers: { 'x-api-key': apiKey } }); const d = await res.json(); if (d && !d.brand) d.brand = payload.brand; if (d.success) renderQuestions(d); else alert('Questions fetch failed: ' + (d.error || JSON.stringify(d))) }
          if (page === 'customers') { const res = await fetch('/api/dashboard/customers', { headers: { 'x-api-key': apiKey } }); const d = await res.json(); if (d && !d.brand) d.brand = payload.brand; if (d.success) renderCustomers(d); else alert('Customers fetch failed: ' + (d.error || JSON.stringify(d))) }
          if (page === 'recommendations') { const res = await fetch('/api/dashboard/recommendations', { headers: { 'x-api-key': apiKey } }); const d = await res.json(); if (d && !d.brand) d.brand = payload.brand; if (d.success) renderRecommendations(d); else alert('Recommendations fetch failed: ' + (d.error || JSON.stringify(d))) }
          if (page === 'revenue') { const res = await fetch('/api/dashboard/revenue', { headers: { 'x-api-key': apiKey } }); const d = await res.json(); if (d && !d.brand) d.brand = payload.brand; if (d.success) renderRevenue(d); else alert('Revenue fetch failed: ' + (d.error || JSON.stringify(d))) }
          if (page === 'aiusage') { const res = await fetch('/api/dashboard/ai', { headers: { 'x-api-key': apiKey } }); const d = await res.json(); if (d && !d.brand) d.brand = payload.brand; if (d.success) renderAIUsage(d); else alert('AI usage fetch failed: ' + (d.error || JSON.stringify(d))) }
        } catch (err) {
          alert('Request error: ' + err.message)
        }
      })
    })
  }

  // always attach handlers so UI remains interactive even if initial overview fails
  attachNavHandlers()

})
