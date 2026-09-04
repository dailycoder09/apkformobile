import { useEffect, useMemo, useState } from 'react'
import {
  Bar as RechartsBar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import * as localData from '../lib/localData'

// Same "don't trust the browser's own timezone" pattern duplicated across this app's
// screens (KhatabookPanel.jsx, MilestonePanel.jsx, TransactionPanel.jsx, and
// HealthTrackerPanel.jsx before it was split up for this rebuild) — kept as its own
// local copy here rather than shared, matching the established convention. Ported
// as-is from HealthTrackerPanel.jsx, which owned this logic before being deleted.
const IST_TZ = 'Asia/Kolkata'
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
// Start of the IST calendar month `n` months before the one containing `ms` — same
// helper as KhatabookPanel.jsx's/TransactionPanel.jsx's sixMonthTrend, reused here for
// the episodes-per-month chart.
function istMonthStartMinus(ms, n) {
  const s = new Date(ms + IST_OFFSET_MS)
  return Date.UTC(s.getUTCFullYear(), s.getUTCMonth() - n, 1) - IST_OFFSET_MS
}

// --color-success / --color-warning / --color-destructive are static tokens from
// tailwind.css's @theme block, same as HealthAnalyticsSection.jsx's/
// HealthTrackerPanel.jsx's matching comment — hardcoding their known oklch values here
// matches that identical convention.
const SUCCESS_COLOR = 'oklch(0.55 0.115 158)'
const WARNING_COLOR = 'oklch(0.68 0.13 62)'
const DESTRUCTIVE_COLOR = 'oklch(0.556 0.185 25)'

function BackArrow() {
  return (
    <svg className="h-6 w-6 stroke-[2.2] stroke-current text-slate-900" fill="none" viewBox="0 0 24 24">
      <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const tip = {
  contentStyle: { borderRadius: 12, border: '1px solid rgba(0,0,0,0.06)', background: '#fff', fontSize: 12 },
}

function StatCard({ value, label }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center rounded-2xl bg-white p-3.5 text-center shadow-[0_2px_10px_rgba(0,0,0,0.03)]">
      <p className="text-2xl font-extrabold text-slate-900">{value}</p>
      <p className="mt-0.5 text-[11px] font-medium text-slate-500">{label}</p>
    </div>
  )
}

function SectionCard({ title, children }) {
  return (
    <div className="rounded-3xl bg-white p-5 shadow-[0_2px_10px_rgba(0,0,0,0.03)]">
      <h2 className="text-sm font-bold text-slate-900">{title}</h2>
      {children}
    </div>
  )
}

export default function HealthInsightsScreen({ onBack }) {
  const [health, setHealth] = useState(null)

  useEffect(() => {
    localData.getHealthData().then(setHealth)
  }, [])

  const episodes = health?.episodes || []

  // All of this is ported essentially as-is from HealthTrackerPanel.jsx (deleted as part
  // of this rebuild) — same computations, same shapes, just re-homed onto this read-only
  // insights screen instead of a live-state panel.
  const stats = useMemo(() => {
    if (!health) return null

    const activeCount = episodes.filter((e) => e.recoveryDate == null).length
    const totalCount = episodes.length

    const resolved = episodes.filter((e) => e.recoveryDate != null)
    const avgRecoveryDays = resolved.length
      ? Math.round((resolved.reduce((s, e) => s + Math.max(0, (e.recoveryDate - e.startDate) / 86400000), 0) / resolved.length) * 10) / 10
      : 0

    const now = new Date(Date.now() + IST_OFFSET_MS)
    const y = now.getUTCFullYear(), m = now.getUTCMonth()
    const thisMonthCount = episodes.filter((e) => {
      const d = new Date(e.startDate + IST_OFFSET_MS)
      return d.getUTCFullYear() === y && d.getUTCMonth() === m
    }).length

    const episodesPerMonth = []
    for (let i = 5; i >= 0; i--) {
      const start = istMonthStartMinus(Date.now(), i)
      const end = istMonthStartMinus(Date.now(), i - 1)
      const count = episodes.filter((e) => e.startDate >= start && e.startDate < end).length
      const label = new Date(start).toLocaleDateString('en-IN', { timeZone: IST_TZ, month: 'short' })
      episodesPerMonth.push({ label, count })
    }

    const symptomCounts = {}
    episodes.forEach((e) => (e.symptoms || []).forEach((s) => { symptomCounts[s] = (symptomCounts[s] || 0) + 1 }))
    const topSymptoms = Object.entries(symptomCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)

    const severityCounts = { mild: 0, moderate: 0, severe: 0 }
    episodes.forEach((e) => { if (severityCounts[e.severity] != null) severityCounts[e.severity]++ })
    const severityBreakdown = [
      { id: 0, label: 'Mild', value: Math.max(severityCounts.mild, 0.01), count: severityCounts.mild, color: SUCCESS_COLOR },
      { id: 1, label: 'Moderate', value: Math.max(severityCounts.moderate, 0.01), count: severityCounts.moderate, color: WARNING_COLOR },
      { id: 2, label: 'Severe', value: Math.max(severityCounts.severe, 0.01), count: severityCounts.severe, color: DESTRUCTIVE_COLOR },
    ]

    const recoveryBySeverity = ['mild', 'moderate', 'severe'].map((level) => {
      const levelResolved = episodes.filter((e) => e.severity === level && e.recoveryDate != null)
      const days = levelResolved.length
        ? Math.round((levelResolved.reduce((s, e) => s + (e.recoveryDate - e.startDate) / 86400000, 0) / levelResolved.length) * 10) / 10
        : 0
      return { name: level.charAt(0).toUpperCase() + level.slice(1), days }
    })

    return {
      activeCount,
      totalCount,
      avgRecoveryDays,
      thisMonthCount,
      episodesPerMonth,
      topSymptoms,
      severityBreakdown,
      recoveryBySeverity,
      resolvedCount: resolved.length,
    }
  }, [health, episodes])

  return (
    <div className="journal-screen surface-sand flex-1 min-h-0 overflow-y-auto flex flex-col font-sans text-slate-800">
      <div className="flex shrink-0 items-center justify-between px-4 py-2.5">
        <button type="button" onClick={onBack} aria-label="Back" className="grid size-9 shrink-0 place-items-center">
          <BackArrow />
        </button>
        <h1 className="text-[19px] font-bold tracking-tight text-slate-900">Insights</h1>
        <div className="w-9" />
      </div>

      {!stats ? null : stats.totalCount === 0 ? (
        <div className="flex flex-1 items-center justify-center px-10 text-center">
          <p className="text-sm text-slate-500">Log your first illness or injury to start seeing recovery trends here.</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-6 pb-8 pt-1">
          <div className="flex gap-2.5">
            <StatCard value={stats.activeCount} label={stats.activeCount === 1 ? 'Active' : 'Active'} />
            <StatCard value={stats.totalCount} label="Episodes" />
            <StatCard value={stats.thisMonthCount} label="This month" />
            <StatCard value={`${stats.avgRecoveryDays}d`} label="Avg recovery" />
          </div>

          <div className="mt-4">
            <SectionCard title="Episodes — Last 6 Months">
              {stats.totalCount === 0 ? (
                <p className="mt-6 text-center text-sm text-slate-400">Log an episode to see your trend.</p>
              ) : (
                <div className="mt-2 h-[190px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={stats.episodesPerMonth} barGap={6}>
                      <CartesianGrid strokeDasharray="3 6" stroke="rgba(0,0,0,0.06)" vertical={false} />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: '#94a3b8' }} />
                      <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={28} tick={{ fontSize: 10, fill: '#94a3b8' }} />
                      <Tooltip {...tip} formatter={(v) => [`${v}`, 'Episodes']} />
                      <RechartsBar dataKey="count" name="Episodes" radius={[8, 8, 0, 0]} fill="#1e2229" barSize={22} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </SectionCard>
          </div>

          <div className="mt-4">
            <SectionCard title="Severity Breakdown">
              {stats.totalCount === 0 ? (
                <p className="mt-6 text-center text-sm text-slate-400">No episodes to break down yet.</p>
              ) : (
                <div className="mt-2 h-[190px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Tooltip {...tip} formatter={(v, n, entry) => [entry.payload.count, entry.payload.label]} />
                      <Pie data={stats.severityBreakdown} dataKey="value" innerRadius={44} outerRadius={66} paddingAngle={4} stroke="none">
                        {stats.severityBreakdown.map((s) => (
                          <Cell key={s.id} fill={s.color} />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="mt-1 flex items-center justify-center gap-4 text-[11px] text-slate-500">
                    {stats.severityBreakdown.map((s) => (
                      <span key={s.id} className="flex items-center gap-1.5">
                        <span className="size-2 rounded-full" style={{ background: s.color }} />
                        {s.label} · {s.count}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </SectionCard>
          </div>

          <div className="mt-4">
            <SectionCard title="Most Common Symptoms">
              {stats.topSymptoms.length === 0 ? (
                <p className="mt-6 text-center text-sm text-slate-400">No symptoms logged yet.</p>
              ) : (
                <div className="mt-2" style={{ height: stats.topSymptoms.length * 34 + 10 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={stats.topSymptoms} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 0 }}>
                      <XAxis type="number" hide allowDecimals={false} />
                      <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={84} tick={{ fontSize: 11, fill: '#475569' }} />
                      <Tooltip {...tip} formatter={(v) => [`${v}`, 'Occurrences']} />
                      <RechartsBar dataKey="count" name="Occurrences" radius={[0, 8, 8, 0]} fill="#1e2229" barSize={16} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </SectionCard>
          </div>

          <div className="mt-4">
            <SectionCard title="Recovery Time">
              <div className="mt-3 flex items-baseline gap-2">
                <p className="text-2xl font-extrabold text-slate-900">
                  {stats.avgRecoveryDays}
                  <span className="text-base font-medium text-slate-500"> days avg</span>
                </p>
              </div>
              {stats.resolvedCount === 0 ? (
                <p className="mt-6 text-center text-sm text-slate-400">No resolved episodes yet.</p>
              ) : (
                <div className="mt-1 h-[140px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={stats.recoveryBySeverity} barGap={6}>
                      <CartesianGrid strokeDasharray="3 6" stroke="rgba(0,0,0,0.06)" vertical={false} />
                      <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: '#94a3b8' }} />
                      <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={28} tick={{ fontSize: 10, fill: '#94a3b8' }} />
                      <Tooltip {...tip} formatter={(v) => [`${v}d`, 'Avg recovery']} />
                      <RechartsBar dataKey="days" name="Avg days" radius={[8, 8, 0, 0]} barSize={26}>
                        {stats.recoveryBySeverity.map((_, i) => (
                          <Cell key={i} fill={[SUCCESS_COLOR, WARNING_COLOR, DESTRUCTIVE_COLOR][i]} />
                        ))}
                      </RechartsBar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </SectionCard>
          </div>
        </div>
      )}
    </div>
  )
}
