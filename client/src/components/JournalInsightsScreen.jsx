import { useEffect, useMemo, useState } from 'react'
import {
  Bar as RechartsBar, BarChart, CartesianGrid, Cell, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import * as localData from '../lib/localData'

// Duplicated locally rather than exported from JournalEntriesScreen.jsx — same
// convention that file already uses for BackArrow, kept as small self-contained
// icon/constant sets per screen instead of a shared-icons module.
const MOODS = [
  { key: 'great', emoji: '😄', label: 'Great', score: 5, color: '#a9dd97' },
  { key: 'good', emoji: '🙂', label: 'Good', score: 4, color: '#a6c9ef' },
  { key: 'okay', emoji: '😐', label: 'Okay', score: 3, color: '#d7dce2' },
  { key: 'low', emoji: '😕', label: 'Low', score: 2, color: '#f2bd80' },
  { key: 'rough', emoji: '😢', label: 'Rough', score: 1, color: '#eda1a1' },
]
const MOOD_BY_KEY = Object.fromEntries(MOODS.map((m) => [m.key, m]))

function BackArrow() {
  return (
    <svg className="h-6 w-6 stroke-[2.2] stroke-current text-slate-900" fill="none" viewBox="0 0 24 24">
      <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
function CameraIcon() {
  return (
    <svg className="h-4 w-4 stroke-current" fill="none" viewBox="0 0 24 24" strokeWidth="1.8">
      <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1-2h7l1 2h2A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-9Z" strokeLinejoin="round" />
      <circle cx="12" cy="13" r="3.3" />
    </svg>
  )
}
function VideoCameraIcon() {
  return (
    <svg className="h-4 w-4 stroke-current" fill="none" viewBox="0 0 24 24" strokeWidth="1.8">
      <rect x="3" y="6" width="12" height="12" rx="1.5" strokeLinejoin="round" />
      <path d="m15 10 5-3v10l-5-3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
function MicIcon() {
  return (
    <svg className="h-4 w-4 stroke-current" fill="none" viewBox="0 0 24 24" strokeWidth="1.8">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" strokeLinecap="round" />
    </svg>
  )
}
function PaperclipIcon() {
  return (
    <svg className="h-4 w-4 stroke-current" fill="none" viewBox="0 0 24 24" strokeWidth="1.8">
      <path d="M8 12.5 15 5.5a3 3 0 0 1 4.2 4.2l-8.5 8.5a5 5 0 0 1-7-7l7.7-7.7" strokeLinecap="round" strokeLinejoin="round" />
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

function computeStreak(entries) {
  const days = new Set(entries.map((e) => new Date(e.createdAt).toDateString()))
  let cursor = new Date()
  if (!days.has(cursor.toDateString())) cursor.setDate(cursor.getDate() - 1)
  let streak = 0
  while (days.has(cursor.toDateString())) {
    streak++
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

function MoodDot({ cx, cy, payload }) {
  if (cx == null || cy == null) return null
  return <circle cx={cx} cy={cy} r={5} fill={payload.color} stroke="#1e2229" strokeWidth={1.2} />
}

export default function JournalInsightsScreen({ onBack }) {
  const [entries, setEntries] = useState(null)

  useEffect(() => {
    localData.getJournalNotesSeeded().then(setEntries)
  }, [])

  const stats = useMemo(() => {
    if (!entries) return null

    const moodCounts = {}
    for (const m of MOODS) moodCounts[m.key] = 0
    for (const e of entries) if (e.mood && moodCounts[e.mood] != null) moodCounts[e.mood]++
    const moodTotal = Object.values(moodCounts).reduce((a, b) => a + b, 0)
    const moodBreakdown = MOODS.map((m) => ({ ...m, count: moodCounts[m.key] })).filter((m) => m.count > 0)
    const topMood = moodBreakdown.slice().sort((a, b) => b.count - a.count)[0] || null

    const moodTrend = entries
      .filter((e) => e.mood)
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-12)
      .map((e) => ({
        label: e.date,
        score: MOOD_BY_KEY[e.mood].score,
        emoji: MOOD_BY_KEY[e.mood].emoji,
        color: MOOD_BY_KEY[e.mood].color,
      }))

    const tagCounts = {}
    for (const e of entries) for (const t of e.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1
    const topTags = Object.entries(tagCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)

    const attachments = entries.reduce(
      (acc, e) => ({
        photo: acc.photo + (e.photoCount || 0),
        video: acc.video + (e.videoCount || 0),
        voice: acc.voice + (e.voiceCount || 0),
        file: acc.file + (e.fileCount || 0),
      }),
      { photo: 0, video: 0, voice: 0, file: 0 }
    )

    return {
      total: entries.length,
      streak: computeStreak(entries),
      topMood,
      moodBreakdown,
      moodTotal,
      moodTrend,
      topTags,
      attachments,
    }
  }, [entries])

  return (
    <div className="journal-screen surface-sand flex-1 min-h-0 overflow-y-auto flex flex-col font-sans text-slate-800">
      <div className="flex shrink-0 items-center justify-between px-4 py-2.5">
        <button type="button" onClick={onBack} aria-label="Back" className="grid size-9 shrink-0 place-items-center">
          <BackArrow />
        </button>
        <h1 className="text-[19px] font-bold tracking-tight text-slate-900">Insights</h1>
        <div className="w-9" />
      </div>

      {!stats ? null : stats.total === 0 ? (
        <div className="flex flex-1 items-center justify-center px-10 text-center">
          <p className="text-sm text-slate-500">Write your first entry to start seeing mood and activity insights here.</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-6 pb-8 pt-1">
          <div className="flex gap-3">
            <StatCard value={stats.total} label="Entries" />
            <StatCard value={stats.streak} label={stats.streak === 1 ? 'Day streak' : 'Day streak'} />
            <StatCard value={stats.topMood ? stats.topMood.emoji : '—'} label={stats.topMood ? `Mostly ${stats.topMood.label}` : 'No mood yet'} />
          </div>

          <div className="mt-4">
            <SectionCard title="Mood breakdown">
              {stats.moodBreakdown.length === 0 ? (
                <p className="mt-6 text-center text-sm text-slate-400">Tap the mood icon on an entry to start tracking.</p>
              ) : (
                <div className="mt-2 h-[170px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Tooltip {...tip} formatter={(v, n, entry) => [entry.payload.count, entry.payload.label]} />
                      <Pie data={stats.moodBreakdown} dataKey="count" innerRadius={42} outerRadius={64} paddingAngle={4} stroke="none">
                        {stats.moodBreakdown.map((m) => (
                          <Cell key={m.key} fill={m.color} />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                    {stats.moodBreakdown.map((m) => (
                      <span key={m.key} className="flex items-center gap-1">
                        <span>{m.emoji}</span>
                        {m.label} · {m.count}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </SectionCard>
          </div>

          <div className="mt-4">
            <SectionCard title="Recent mood trend">
              {stats.moodTrend.length < 2 ? (
                <p className="mt-6 text-center text-sm text-slate-400">Set moods on a few entries to see your trend.</p>
              ) : (
                <div className="mt-2 h-[150px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={stats.moodTrend} margin={{ left: -12, right: 8 }}>
                      <CartesianGrid strokeDasharray="3 6" stroke="rgba(0,0,0,0.06)" vertical={false} />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 9, fill: '#94a3b8' }} />
                      <YAxis
                        domain={[0.5, 5.5]}
                        ticks={[1, 2, 3, 4, 5]}
                        tickLine={false}
                        axisLine={false}
                        width={22}
                        tick={({ x, y, payload }) => (
                          <text x={x} y={y + 4} textAnchor="end" fontSize={11}>
                            {MOODS.find((m) => m.score === payload.value)?.emoji}
                          </text>
                        )}
                      />
                      <Tooltip {...tip} formatter={(v, n, entry) => [entry.payload.emoji, 'Mood']} />
                      <Line type="monotone" dataKey="score" stroke="#1e2229" strokeWidth={1.6} dot={<MoodDot />} activeDot={{ r: 6 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </SectionCard>
          </div>

          {stats.topTags.length > 0 && (
            <div className="mt-4">
              <SectionCard title="Most used tags">
                <div className="mt-2" style={{ height: stats.topTags.length * 34 + 10 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={stats.topTags} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 0 }}>
                      <XAxis type="number" hide allowDecimals={false} />
                      <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={78} tick={{ fontSize: 11, fill: '#475569' }} />
                      <Tooltip {...tip} formatter={(v) => [`${v}`, 'Entries']} />
                      <RechartsBar dataKey="count" radius={[0, 8, 8, 0]} fill="#1e2229" barSize={14} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </SectionCard>
            </div>
          )}

          <div className="mt-4">
            <SectionCard title="Attachments so far">
              <div className="mt-3 grid grid-cols-4 gap-2">
                {[
                  { Icon: CameraIcon, value: stats.attachments.photo, label: 'Photos' },
                  { Icon: VideoCameraIcon, value: stats.attachments.video, label: 'Videos' },
                  { Icon: MicIcon, value: stats.attachments.voice, label: 'Voice' },
                  { Icon: PaperclipIcon, value: stats.attachments.file, label: 'Files' },
                ].map(({ Icon, value, label }) => (
                  <div key={label} className="flex flex-col items-center gap-1 rounded-2xl bg-black/[0.03] py-3">
                    <Icon />
                    <span className="text-base font-bold text-slate-900">{value}</span>
                    <span className="text-[10px] font-medium text-slate-500">{label}</span>
                  </div>
                ))}
              </div>
            </SectionCard>
          </div>
        </div>
      )}
    </div>
  )
}
