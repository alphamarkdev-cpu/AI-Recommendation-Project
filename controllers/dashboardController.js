const path = require('path')
const supabase = require('../config/supabase')
const {
  countRows,
  safeCountRows,
  safeSelect,
  todayIso,
  monthStartIso,
  daysAgoIso,
  groupByDay,
  percentage,
  uniqueCount
} = require('../utils/dashboardMetrics')

function handleError(res, error) {
  const payload = { success: false, error: error.message }
  if (process.env.NODE_ENV !== 'production') payload.stack = error.stack
  return res.status(500).json(payload)
}

const dashboardPage = (req, res) => {
  // Serve the static dashboard prototype stored in the repository's dashboard/ folder.
  res.sendFile(path.join(__dirname, '..', 'dashboard', 'index.html'))
}

const scopedQuery = (table, req) => {
  const builder = supabase.from(table)

  if (!builder) throw new Error('Supabase "from" returned a falsy value')

  // Wrap the builder in a proxy so chained calls remain chainable and
  // we can provide clearer errors when a method is missing.
  const createQueryProxy = (target) => new Proxy(target, {
    get(t, prop) {
      // Allow awaiting the builder (thenable forwarding)
      if (prop === 'then') {
        if (typeof t.then === 'function') return t.then.bind(t)
        return undefined
      }

      const val = t[prop]
      if (typeof val === 'function') {
        return (...args) => {
          const res = val.apply(t, args)
          return createQueryProxy(res)
        }
      }

      if (val !== undefined) return val

      // Fallback: some supabase builders expose filtering methods only after
      // calling .select(). If the method is missing, try calling .select('*')
      // and look up the method on the result.
      if (typeof t.select === 'function') {
        try {
          const afterSelect = t.select('*')
          const alt = afterSelect[prop]
          if (typeof alt === 'function') {
            return (...args) => {
              const res = alt.apply(afterSelect, args)
              return createQueryProxy(res)
            }
          }
        } catch (e) {
          // ignore and fall through to throw below
        }
      }

      return () => { throw new Error(`Supabase query builder has no method '${String(prop)}'`) }
    }
  })

  let query = createQueryProxy(builder)

  // Apply mandatory brand scoping if available.
  if (typeof query.eq === 'function') {
    query = query.eq('brand_id', req.brand.brand_id)
    const storeId = req.query.store_id
    if (storeId && storeId !== 'all' && typeof query.eq === 'function') query = query.eq('store_id', storeId)
  }

  return query
}

const getStores = async brandId => {
  const { data, error } = await supabase
    .from('shopify_stores')
    .select('id, shop_domain, installed_at, uninstalled_at, brand_id')
    .eq('brand_id', brandId)
    .order('installed_at', { ascending: false })

  if (error) throw error
  return data || []
}

const getBrandContext = async req => {
  const stores = await getStores(req.brand.brand_id)
  const selectedStoreId = req.query.store_id && req.query.store_id !== 'all'
    ? req.query.store_id
    : null
  const selectedStore = selectedStoreId
    ? stores.find(store => store.id === selectedStoreId)
    : null

  return {
    brand: req.brand,
    stores,
    selectedStore,
    selectedStoreId
  }
}

const getOverview = async (req, res) => {
  try {
    const { brand, stores, selectedStore, selectedStoreId } = await getBrandContext(req)
    const activeStores = stores.filter(store => !store.uninstalled_at)
    const category = selectedStore?.product_category || brand.product_category || 'general'
    const today = todayIso()
    const monthStart = monthStartIso()

    const productsQuery = scopedQuery('products', req).eq('is_active', true)
    const sessionsQuery = scopedQuery('consumer_sessions', req)
    const todaySessionsQuery = scopedQuery('consumer_sessions', req).gte('created_at', today)
    const monthSessionsQuery = scopedQuery('consumer_sessions', req).gte('created_at', monthStart)

    const [
      totalProducts,
      totalSessions,
      todayRecommendations,
      monthlyRecommendations,
      activeUsersToday,
      orders,
      influencedOrders
    ] = await Promise.all([
      countRows(productsQuery),
      safeCountRows(sessionsQuery),
      safeCountRows(todaySessionsQuery),
      safeCountRows(monthSessionsQuery),
      safeCountRows(scopedQuery('consumer_sessions', req).gte('created_at', today)),
      safeCountRows(scopedQuery('recommendation_orders', req).gte('created_at', monthStart)),
      safeCountRows(scopedQuery('recommendation_orders', req).eq('influenced_by_recommendation', true).gte('created_at', monthStart))
    ])

    // Get recent orders and session data for charts (last 30 days)
    const recentOrders = await safeSelect(
      scopedQuery('recommendation_orders', req)
        .select('revenue, influenced_by_recommendation, created_at')
        .gte('created_at', daysAgoIso(30))
    )

    const recentSessions = await safeSelect(
      scopedQuery('consumer_sessions', req)
        .select('created_at')
        .gte('created_at', daysAgoIso(30))
    )

    // Build 30-day grouped series then take the last 7 days for the overview charts
    const revenueTrend30 = groupByDay(recentOrders, 'created_at', 'revenue')
    const recommendationTrend30 = groupByDay(recentSessions, 'created_at')
    const revenueTrend = revenueTrend30.slice(-7)
    const recommendationTrend = recommendationTrend30.slice(-7)

    res.json({
      success: true,
      brand: {
        id: brand.brand_id,
        name: brand.name,
        slug: brand.slug,
        category,
        primary_color: selectedStore?.primary_color || brand.primary_color || '#1B4332'
      },
      selected_store_id: selectedStoreId || 'all',
      stores,
      kpis: {
        total_active_stores: selectedStoreId ? 1 : activeStores.length,
        total_products_synced: totalProducts,
        todays_recommendations: todayRecommendations,
        monthly_recommendations: monthlyRecommendations,
        recommendation_conversion_rate: percentage(influencedOrders || orders, totalSessions),
        active_users_today: activeUsersToday
      }
      ,
      charts: {
        revenue_trend: revenueTrend,
        recommendation_trend: recommendationTrend
      }
    })
  } catch (error) {
    return handleError(res, error)
  }
}

const getProducts = async (req, res) => {
  try {
    const products = await safeSelect(
      scopedQuery('products', req)
        .select(`
          product_id,
          store_id,
          name,
          category,
          description,
          price,
          image_url,
          product_url,
          vendor,
          product_tags,
          suitable_customer_attributes,
          external_product_id,
          is_active,
          product_match_tags(match_tag, intensity_level, priority_score)
        `)
        .order('name')
    )

    res.json({
      success: true,
      kpis: {
        products_synced: products.length,
        ai_metadata: products.filter(product => product.description || product.suitable_customer_attributes?.length).length,
        product_images: products.filter(product => product.image_url).length,
        variants: uniqueCount(products.map(product => product.external_product_id)),
        match_tags: products.reduce((total, product) => total + (product.product_match_tags || []).length, 0)
      },
      products
    })
  } catch (error) {
    return handleError(res, error)
  }
}

const getQuestions = async (req, res) => {
  try {
    const { brand, selectedStore } = await getBrandContext(req)
    const flows = await safeSelect(
      scopedQuery('brand_question_flows', req)
        .select('flow_id, store_id, category, version, questions_json, flow_json, is_active, updated_at')
        .order('updated_at', { ascending: false })
    )

    res.json({
      success: true,
      brand: {
        name: brand.name,
        category: selectedStore?.product_category || brand.product_category || 'general'
      },
      flows,
      active_flow: flows.find(flow => flow.is_active) || null
    })
  } catch (error) {
    return handleError(res, error)
  }
}

const getCustomerAnalytics = async (req, res) => {
  try {
    const sessions = await safeSelect(
      scopedQuery('consumer_sessions', req)
        .select('session_id, answers_json, photo_analysis_json, recommended_product_ids, created_at')
        .gte('created_at', daysAgoIso(30))
    )

    const imageUploads = sessions.filter(session => Boolean(session.photo_analysis_json)).length
    const clarifications = sessions.filter(session => Boolean(session.answers_json?.clarification_answers)).length
    const recommendations = sessions.filter(session => (session.recommended_product_ids || []).length).length

    res.json({
      success: true,
      kpis: {
        total_sessions: sessions.length,
        completed_sessions: recommendations,
        image_upload_percent: percentage(imageUploads, sessions.length),
        clarification_percent: percentage(clarifications, sessions.length),
        recommendation_percent: percentage(recommendations, sessions.length),
        purchase_percent: 0,
        average_session_time: 'N/A'
      },
      trend: groupByDay(sessions)
    })
  } catch (error) {
    return handleError(res, error)
  }
}

const getRecommendationAnalytics = async (req, res) => {
  try {
    const sessions = await safeSelect(
      scopedQuery('consumer_sessions', req)
        .select('answers_json, recommended_product_ids, created_at')
        .gte('created_at', daysAgoIso(30))
    )
    const productIds = sessions.flatMap(session => session.recommended_product_ids || [])
    const topCounts = productIds.reduce((counts, productId) => {
      counts[productId] = (counts[productId] || 0) + 1
      return counts
    }, {})
    const topIds = Object.entries(topCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([productId]) => productId)
    const topProducts = topIds.length
      ? await safeSelect(
        supabase
          .from('products')
          .select('product_id, name, image_url, product_url')
          .in('product_id', topIds)
      )
      : []
    const concernCounts = sessions.reduce((counts, session) => {
      const concern = session.answers_json?.primary_concern ||
        session.answers_json?.concerns?.[0] ||
        session.answers_json?.concern ||
        'Not specified'
      counts[concern] = (counts[concern] || 0) + 1
      return counts
    }, {})

    res.json({
      success: true,
      kpis: {
        recommendations_generated: sessions.length,
        products_recommended: productIds.length,
        most_selected_concern: Object.entries(concernCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A'
      },
      top_recommended_products: topProducts.map(product => ({
        ...product,
        recommendation_count: topCounts[product.product_id] || 0
      })),
      trend: groupByDay(sessions)
    })
  } catch (error) {
    return handleError(res, error)
  }
}

const getRevenue = async (req, res) => {
  try {
    const orders = await safeSelect(
      scopedQuery('recommendation_orders', req)
        .select('revenue, influenced_by_recommendation, created_at')
        .gte('created_at', daysAgoIso(30))
    )
    const recommendations = await safeCountRows(scopedQuery('consumer_sessions', req).gte('created_at', daysAgoIso(30)))
    const revenueGenerated = orders.reduce((total, order) => total + Number(order.revenue || 0), 0)
    const revenueInfluenced = orders
      .filter(order => order.influenced_by_recommendation)
      .reduce((total, order) => total + Number(order.revenue || 0), 0)

    res.json({
      success: true,
      kpis: {
        revenue_generated: revenueGenerated,
        revenue_influenced: revenueInfluenced,
        conversion_percent: percentage(orders.length, recommendations),
        aov: orders.length ? Math.round((revenueGenerated / orders.length) * 100) / 100 : 0,
        orders: orders.length,
        recommendations,
        revenue_per_recommendation: recommendations ? Math.round((revenueInfluenced / recommendations) * 100) / 100 : 0
      },
      charts: {
        revenue_trend: groupByDay(orders, 'created_at', 'revenue'),
        conversion_trend: groupByDay(orders),
        recommendation_trend: []
      }
    })
  } catch (error) {
    return handleError(res, error)
  }
}

const getAiUsage = async (req, res) => {
  try {
    const usage = await safeSelect(
      scopedQuery('ai_usage_logs', req)
        .select('request_type, input_tokens, output_tokens, total_tokens, cost, response_time_ms, success, created_at')
        .gte('created_at', daysAgoIso(30))
    )
    const totalTokens = usage.reduce((total, item) => total + Number(item.total_tokens || 0), 0)
    const totalCost = usage.reduce((total, item) => total + Number(item.cost || 0), 0)
    const successes = usage.filter(item => item.success !== false).length

    res.json({
      success: true,
      kpis: {
        ai_requests: usage.length,
        question_generation_calls: usage.filter(item => item.request_type === 'question_generation').length,
        recommendation_calls: usage.filter(item => item.request_type === 'recommendation').length,
        average_tokens: usage.length ? Math.round(totalTokens / usage.length) : 0,
        monthly_cost: Math.round(totalCost * 100) / 100,
        average_response_time: usage.length
          ? Math.round(usage.reduce((total, item) => total + Number(item.response_time_ms || 0), 0) / usage.length)
          : 0,
        success_percent: percentage(successes, usage.length),
        failure_percent: percentage(usage.length - successes, usage.length)
      },
      trend: groupByDay(usage)
    })
  } catch (error) {
    return handleError(res, error)
  }
}

module.exports = {
  dashboardPage,
  getOverview,
  getProducts,
  getQuestions,
  getCustomerAnalytics,
  getRecommendationAnalytics,
  getRevenue,
  getAiUsage
}
