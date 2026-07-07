const { DateTime } = require('luxon')

// Lightweight helper utilities for dashboard metrics endpoints.
// These are intentionally small and defensive — returning zero/empty
// on errors so the dashboard endpoints can remain robust in dev.

const countRows = async (query) => {
  try {
    // Use head + count to avoid fetching rows
    const { count, error } = await query.select('*', { count: 'exact', head: true })
    if (error) throw error
    return count || 0
  } catch (err) {
    throw err
  }
}

const safeCountRows = async (query) => {
  try {
    return await countRows(query)
  } catch (err) {
    return 0
  }
}

const safeSelect = async (query) => {
  try {
    const { data, error } = await query
    if (error) throw error
    return data || []
  } catch (err) {
    return []
  }
}

const todayIso = () => DateTime.utc().startOf('day').toISO()

const monthStartIso = () => DateTime.utc().startOf('month').toISO()

const daysAgoIso = (days = 30) => DateTime.utc().minus({ days }).startOf('day').toISO()

const groupByDay = (items = [], dateKey = 'created_at', valueKey = null) => {
  // Return an array of { date: 'YYYY-MM-DD', value: number } for last 30 days
  const start = DateTime.fromISO(daysAgoIso(30))
  const map = {}
  for (let i = 0; i < 31; i++) {
    const d = start.plus({ days: i })
    map[d.toISODate()] = 0
  }

  items.forEach(item => {
    const raw = item[dateKey]
    if (!raw) return
    const dt = DateTime.fromISO(raw)
    if (!dt.isValid) return
    const key = dt.toISODate()
    if (!(key in map)) return
    if (valueKey) map[key] += Number(item[valueKey] || 0)
    else map[key] += 1
  })

  return Object.entries(map).map(([date, value]) => ({ date, value }))
}

const percentage = (part, total) => {
  const p = Number(part || 0)
  const t = Number(total || 0)
  if (!t) return 0
  return Math.round((p / t) * 10000) / 100
}

const uniqueCount = (arr = []) => new Set(arr.filter(Boolean)).size

module.exports = {
  countRows,
  safeCountRows,
  safeSelect,
  todayIso,
  monthStartIso,
  daysAgoIso,
  groupByDay,
  percentage,
  uniqueCount
}
