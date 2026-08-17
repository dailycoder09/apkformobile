// Pure client-side recurring-payment detector for the Finance tab — flags transaction
// groups that look like subscriptions/bills/EMIs: same merchant, roughly the same
// amount, landing on roughly the same day of the month across 2+ distinct calendar
// months. Deliberately NOT just "same merchant 2+ times" — that would false-positive on
// someone who just shops at the same place often (e.g. the same grocery store every
// week). The actual signal this looks for is month-over-month *regularity*, which is
// what makes something a fixed recurring commitment rather than ordinary discretionary
// spending. Runs entirely over transactions already loaded on the client — no new
// server round-trip.

// Recharges/bills often vary a little month to month (usage-based charges, taxes,
// rounding) — ±10% keeps those together as one recurring group instead of splitting
// them into unrelated one-off amounts.
const AMOUNT_TOLERANCE = 0.10

// How many days apart (month to month) an occurrence's day-of-month may drift and still
// count as "the same billing date" — covers e.g. a bill that's auto-paid a day or two
// late/early, or a due date that shifts slightly around a weekend.
const DAY_OF_MONTH_TOLERANCE = 5

// Normalizes a merchant string for grouping: lowercase, drop punctuation, and strip long
// numeric runs (order IDs, UTRs, phone numbers) that would otherwise make every
// occurrence of an otherwise-identical merchant look like a distinct merchant.
function normalizeMerchant(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b\d{3,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function monthKey(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth()}`
}

// Circular distance between two days-of-month, treating the month as a ~30-day loop —
// so a bill landing on the 30th one month and the 1st/2nd the next (because the
// previous month was shorter) is recognized as consistent, not 28+ days apart.
function dayOfMonthDistance(a, b) {
  const diff = Math.abs(a - b)
  return Math.min(diff, 30 - diff)
}

// Clusters a single merchant's transactions by amount similarity (±AMOUNT_TOLERANCE of
// the cluster's running average), since one merchant can have multiple genuinely
// different recurring charges at different price points (e.g. two different
// subscriptions billed under the same brand name).
function clusterByAmount(txns) {
  const sorted = [...txns].sort((a, b) => a.amount - b.amount)
  const clusters = []
  for (const t of sorted) {
    const cluster = clusters.find(c => Math.abs(t.amount - c.avg) <= c.avg * AMOUNT_TOLERANCE)
    if (cluster) {
      cluster.items.push(t)
      cluster.avg = cluster.items.reduce((s, x) => s + x.amount, 0) / cluster.items.length
    } else {
      clusters.push({ avg: t.amount, items: [t] })
    }
  }
  return clusters
}

// Analyzes a transaction list and returns:
//   groups       — array of { key, merchant, amount, cadence, occurrences, months, lastDate }
//                  for every detected recurring group, most-recent-amount-first is not
//                  guaranteed order — callers should sort as needed.
//   byTxnId      — Map<transactionId, groupKey>, for an O(1) "is this transaction part of
//                  a recurring group?" check when rendering the Recurring badge on a card.
//   totalMonthly — sum of the latest amount from every detected group — the headline
//                  "₹X/month in recurring payments" figure.
//
// Only debit transactions are considered — recurring *commitments* (bills, subscriptions,
// EMIs) are the useful signal for a parent distinguishing fixed vs. discretionary
// spending; recurring credits (e.g. salary) aren't a "payment" in that sense.
export function detectRecurring(transactions) {
  const debitTxns = (transactions || []).filter(t => t.type === 'debit' && t.merchant)

  const byMerchant = {}
  debitTxns.forEach(t => {
    const key = normalizeMerchant(t.merchant)
    if (!key) return
    if (!byMerchant[key]) byMerchant[key] = []
    byMerchant[key].push(t)
  })

  const groups = []
  const byTxnId = new Map()

  Object.entries(byMerchant).forEach(([merchantKey, txns]) => {
    if (txns.length < 2) return

    clusterByAmount(txns).forEach((cluster, clusterIdx) => {
      if (cluster.items.length < 2) return

      // Require 2+ *distinct calendar months* — same-month repeats (e.g. two separate
      // Swiggy orders in one week) are ordinary frequent shopping, not recurrence.
      const distinctMonths = [...new Set(cluster.items.map(t => monthKey(t.date)))]
      if (distinctMonths.length < 2) return

      // Require the billing date to land on roughly the same day each month.
      const daysOfMonth = cluster.items.map(t => new Date(t.date).getDate())
      const maxSpread = Math.max(
        ...daysOfMonth.flatMap((d1, i) => daysOfMonth.slice(i + 1).map(d2 => dayOfMonthDistance(d1, d2)))
      )
      if (maxSpread > DAY_OF_MONTH_TOLERANCE) return

      const sortedItems = [...cluster.items].sort((a, b) => b.date - a.date)
      const groupKey = `${merchantKey}::${clusterIdx}`
      groups.push({
        key: groupKey,
        merchant: sortedItems[0].merchant,
        amount: sortedItems[0].amount,
        cadence: 'monthly',
        occurrences: sortedItems.length,
        months: distinctMonths.length,
        lastDate: sortedItems[0].date,
      })
      cluster.items.forEach(t => byTxnId.set(t.id, groupKey))
    })
  })

  const totalMonthly = groups.reduce((sum, g) => sum + g.amount, 0)
  return { groups, byTxnId, totalMonthly }
}
