import { useState, useEffect, useMemo } from 'react'
import { PageShell } from './PageShell'
import HealthEpisodesSection from './HealthEpisodesSection'
import HealthAnalyticsSection from './HealthAnalyticsSection'

// Same "don't trust the browser's own timezone" pattern duplicated across this app's other
// screens — kept as its own local copy here rather than shared, matching the established
// convention (see HealthTrackerPanel.jsx's identical comment).
const IST_TZ = 'Asia/Kolkata'
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
function istMonthStartMinus(ms, n) {
  const s = new Date(ms + IST_OFFSET_MS)
  return Date.UTC(s.getUTCFullYear(), s.getUTCMonth() - n, 1) - IST_OFFSET_MS
}

// Read-only parent view of a child's health episodes — mirrors AdminMilestoneView.jsx's
// per-user fetch loop and user_joined/user_left handling exactly, scoped to
// health_data_get/health_data instead of milestone_data_get/milestone_data. No add/edit/
// delete controls: a parent can see episodes, not change them.
//
// Unlike AdminMilestoneView.jsx (which duplicates its own bespoke JSX/CSS), this view reuses
// HealthEpisodesSection.jsx and HealthAnalyticsSection.jsx exactly as the self-service
// HealthTrackerPanel.jsx does — both already render fine read-only simply by not being
// passed `onOpenEpisode`/`onAddEpisode` (see EpisodeRow in HealthEpisodesSection.jsx), so
// there's no read-only variant JSX to keep in sync here.
export default function AdminHealthView({ initialUsers, sendMsg, addListener, onHome }) {
  const [users, setUsers] = useState(initialUsers || [])
  const [episodesByUser, setEpisodesByUser] = useState({}) // { [userId]: episode[] }
  const [activeUser, setActiveUser] = useState(initialUsers?.[0]?.id || null)

  useEffect(() => {
    users.forEach(u => sendMsg({ type: 'health_data_get', userId: u.id }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return addListener((msg) => {
      if (msg.type === 'health_data') {
        setEpisodesByUser(prev => ({ ...prev, [msg.userId]: msg.episodes || [] }))
      }
      if (msg.type === 'health_episode_new') {
        setEpisodesByUser(prev => {
          const cur = prev[msg.fromUserId] || []
          const exists = cur.find(e => e.id === msg.episode.id)
          return { ...prev, [msg.fromUserId]: exists ? cur : [msg.episode, ...cur] }
        })
      }
      if (msg.type === 'health_episode_updated') {
        setEpisodesByUser(prev => {
          const cur = prev[msg.fromUserId] || []
          return { ...prev, [msg.fromUserId]: cur.map(e => e.id === msg.episode.id ? msg.episode : e) }
        })
      }
      if (msg.type === 'health_episode_deleted') {
        setEpisodesByUser(prev => {
          const cur = prev[msg.fromUserId] || []
          return { ...prev, [msg.fromUserId]: cur.filter(e => e.id !== msg.id) }
        })
      }
      if (msg.type === 'user_joined') {
        setUsers(prev => prev.find(u => u.id === msg.user.id) ? prev : [...prev, msg.user])
        sendMsg({ type: 'health_data_get', userId: msg.user.id })
        setActiveUser(prev => prev || msg.user.id)
      }
      if (msg.type === 'user_left') {
        setUsers(prev => prev.filter(u => u.id !== msg.userId))
      }
    })
  }, [addListener, sendMsg])

  const episodes = episodesByUser[activeUser] || []
  const sortedEpisodes = useMemo(
    () => [...episodes].sort((a, b) => (b.startDate || 0) - (a.startDate || 0)),
    [episodes]
  )

  const activeCount = useMemo(() => episodes.filter(e => e.recoveryDate == null).length, [episodes])
  const totalCount = episodes.length
  const avgRecoveryDays = useMemo(() => {
    const resolved = episodes.filter(e => e.recoveryDate != null)
    if (resolved.length === 0) return 0
    const total = resolved.reduce((s, e) => s + Math.max(0, (e.recoveryDate - e.startDate) / 86400000), 0)
    return Math.round((total / resolved.length) * 10) / 10
  }, [episodes])
  const thisMonthCount = useMemo(() => {
    const now = new Date(Date.now() + IST_OFFSET_MS)
    const y = now.getUTCFullYear(), m = now.getUTCMonth()
    return episodes.filter(e => {
      const d = new Date(e.startDate + IST_OFFSET_MS)
      return d.getUTCFullYear() === y && d.getUTCMonth() === m
    }).length
  }, [episodes])
  const episodesPerMonth = useMemo(() => {
    const months = []
    for (let i = 5; i >= 0; i--) {
      const start = istMonthStartMinus(Date.now(), i)
      const end = istMonthStartMinus(Date.now(), i - 1)
      const count = episodes.filter(e => e.startDate >= start && e.startDate < end).length
      const label = new Date(start).toLocaleDateString('en-IN', { timeZone: IST_TZ, month: 'short' })
      months.push({ label, count })
    }
    return months
  }, [episodes])
  const topSymptoms = useMemo(() => {
    const counts = {}
    episodes.forEach(e => (e.symptoms || []).forEach(s => { counts[s] = (counts[s] || 0) + 1 }))
    return Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
  }, [episodes])
  const severityBreakdown = useMemo(() => {
    const counts = { mild: 0, moderate: 0, severe: 0 }
    episodes.forEach(e => { if (counts[e.severity] != null) counts[e.severity]++ })
    return [
      { id: 0, label: 'Mild', value: Math.max(counts.mild, 0.01), count: counts.mild, color: 'oklch(0.55 0.115 158)' },
      { id: 1, label: 'Moderate', value: Math.max(counts.moderate, 0.01), count: counts.moderate, color: 'oklch(0.68 0.13 62)' },
      { id: 2, label: 'Severe', value: Math.max(counts.severe, 0.01), count: counts.severe, color: 'oklch(0.556 0.185 25)' },
    ]
  }, [episodes])
  const recoveryBySeverity = useMemo(() => {
    return ['mild', 'moderate', 'severe'].map(level => {
      const resolved = episodes.filter(e => e.severity === level && e.recoveryDate != null)
      const days = resolved.length
        ? Math.round((resolved.reduce((s, e) => s + (e.recoveryDate - e.startDate) / 86400000, 0) / resolved.length) * 10) / 10
        : 0
      return { name: level.charAt(0).toUpperCase() + level.slice(1), days }
    })
  }, [episodes])

  return (
    <div className="health-screen font-sans">
      <PageShell
        eyebrow="Module 05"
        title="Health"
        lead="Read-only view of a family member's illnesses and recoveries."
        onHome={onHome}
        action={
          <div className="tile-static hidden shrink-0 px-5 py-3 text-right sm:block">
            <p className="num text-2xl font-extrabold text-foreground">{activeCount}</p>
            <p className="text-[11px] text-muted-foreground">active illness{activeCount !== 1 ? 'es' : ''}</p>
          </div>
        }
      >
        {users.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <span className="material-symbols-outlined text-4xl text-muted-foreground">group_off</span>
            <p className="font-semibold text-foreground">No family members connected yet</p>
          </div>
        ) : (
          <>
            <div className="txn-user-tabs">
              {users.map(u => (
                <button
                  key={u.id}
                  className={`txn-user-tab${activeUser === u.id ? ' active' : ''}`}
                  onClick={() => setActiveUser(u.id)}
                >
                  {u.name}
                </button>
              ))}
            </div>

            <div className="mt-4 flex flex-col gap-4">
              <HealthEpisodesSection
                episodes={episodes}
                sortedEpisodes={sortedEpisodes}
                activeCount={activeCount}
                totalCount={totalCount}
                avgRecoveryDays={avgRecoveryDays}
                thisMonthCount={thisMonthCount}
              />
              <HealthAnalyticsSection
                episodes={episodes}
                episodesPerMonth={episodesPerMonth}
                topSymptoms={topSymptoms}
                severityBreakdown={severityBreakdown}
                avgRecoveryDays={avgRecoveryDays}
                recoveryBySeverity={recoveryBySeverity}
              />
            </div>
          </>
        )}
      </PageShell>
    </div>
  )
}
