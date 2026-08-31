import {
  Area, AreaChart, Bar as RechartsBar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { Tile, TileLabel } from './PageShell'
import { formatShortDate } from '../utils/journalFormat'

const tip = {
  contentStyle: {
    borderRadius: 12,
    border: '1px solid var(--color-border)',
    background: 'var(--color-popover)',
    fontSize: 12,
  },
}

function DigestStat({ label, value }) {
  return (
    <div>
      <p className="truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className="num mt-1 truncate text-base font-extrabold text-foreground">{value}</p>
    </div>
  )
}

// Page 2 of the mobile split: read-only trends. Pure presentational, same data
// JournalPanel.jsx already computes — see JournalEntriesSection.jsx for why this is a plain
// props-in component rather than owning any state of its own.
export default function JournalAnalyticsSection({
  entries,
  moodEnergyTrend,
  moodSplit,
  weeklyDigest,
  moodHint,
  tagFrequency,
  namazMoodCorrelation,
}) {
  return (
    <div className="px-1">
      <Tile>
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-lg text-gold">insights</span>
          <TileLabel>Mood &amp; Energy — Last 14 Days</TileLabel>
        </div>
        {entries.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">Log an entry to see your trend.</p>
        ) : (
          <>
            <div className="mt-3 flex items-center gap-4 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: 'var(--chart-1)' }} />
                Mood
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: 'var(--chart-2)' }} />
                Energy
              </span>
            </div>
            <div className="mt-1 h-[190px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={moodEnergyTrend} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="journalMood" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="journalEnergy" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <YAxis hide domain={[0, 5]} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} />
                  <Tooltip {...tip} formatter={(v, name) => [v != null ? Number(v).toFixed(1) : '—', name === 'mood' ? 'Mood' : 'Energy']} />
                  <Area type="monotone" dataKey="mood" name="mood" stroke="var(--chart-1)" strokeWidth={2.5} fill="url(#journalMood)" connectNulls dot={{ r: 3, strokeWidth: 0, fill: 'var(--chart-1)' }} />
                  <Area type="monotone" dataKey="energy" name="energy" stroke="var(--chart-2)" strokeWidth={2.5} fill="url(#journalEnergy)" connectNulls dot={{ r: 3, strokeWidth: 0, fill: 'var(--chart-2)' }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </Tile>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Tile>
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-lg text-gold">donut_small</span>
            <TileLabel>Mood Split</TileLabel>
          </div>
          {entries.length === 0 ? (
            <p className="mt-8 text-center text-sm text-muted-foreground">No entries to break down yet.</p>
          ) : (
            <div className="mt-2 h-[190px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Tooltip {...tip} formatter={(v, n, entry) => [entry.payload.count, entry.payload.label]} />
                  <Pie data={moodSplit} dataKey="value" innerRadius={44} outerRadius={66} paddingAngle={4} stroke="none">
                    {moodSplit.map(s => <Cell key={s.id} fill={s.color} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="mt-1 flex items-center justify-center gap-4 text-[11px] text-muted-foreground">
                {moodSplit.map(s => (
                  <span key={s.id} className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full" style={{ background: s.color }} />
                    {s.label} · {s.count}
                  </span>
                ))}
              </div>
            </div>
          )}
        </Tile>

        <Tile>
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-lg text-gold">lightbulb</span>
            <TileLabel>Mood Hints</TileLabel>
          </div>
          <p className="mt-6 text-sm text-foreground">
            {moodHint || 'Not enough tagged entries yet.'}
          </p>
        </Tile>
      </div>

      <Tile className="mt-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-lg text-gold">mosque</span>
          <TileLabel>Mood &amp; Prayer</TileLabel>
        </div>
        <p className="mt-6 text-sm text-foreground">
          {namazMoodCorrelation
            ? `Your average mood is ${namazMoodCorrelation.fullAvg.toFixed(1)}/5 on days you completed all 5 prayers, vs ${namazMoodCorrelation.partialAvg.toFixed(1)}/5 on days you missed one or more. Based on ${namazMoodCorrelation.overlap} days with both a Journal entry and prayer data.`
            : 'Not enough overlapping Journal + prayer data yet.'}
        </p>
      </Tile>

      <Tile className="mt-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-lg text-gold">summarize</span>
          <TileLabel>Weekly Digest</TileLabel>
        </div>
        {!weeklyDigest ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">No entries this week yet.</p>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <DigestStat label="Entries" value={weeklyDigest.count} />
              <DigestStat label="Avg Mood" value={`${weeklyDigest.avgMoodScore.toFixed(1)}/5`} />
              <DigestStat label="Avg Energy" value={`${weeklyDigest.avgEnergy.toFixed(1)}/5`} />
              <DigestStat label="Avg Sleep" value={`${weeklyDigest.avgSleep.toFixed(1)}h`} />
              <DigestStat label="Best Day" value={weeklyDigest.bestDate != null ? formatShortDate(weeklyDigest.bestDate) : '—'} />
              <DigestStat label="Lowest Day" value={weeklyDigest.worstDate != null ? formatShortDate(weeklyDigest.worstDate) : '—'} />
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Top themes: {weeklyDigest.topThemes.length ? weeklyDigest.topThemes.join(', ') : 'none tagged yet'}
            </p>
          </>
        )}
      </Tile>

      <Tile className="mt-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-lg text-gold">sell</span>
          <TileLabel>What Your Days Are About</TileLabel>
        </div>
        {tagFrequency.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">Tag entries to see your themes.</p>
        ) : (
          <div className="mt-2 h-[210px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={tagFrequency} layout="vertical" margin={{ left: 8, right: 12 }}>
                <CartesianGrid strokeDasharray="3 6" stroke="var(--color-border)" horizontal={false} />
                <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} />
                <YAxis type="category" dataKey="tag" tickLine={false} axisLine={false} width={84} tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }} />
                <Tooltip {...tip} formatter={(v) => [`${v}`, 'Entries']} />
                <RechartsBar dataKey="count" name="Entries" radius={[0, 8, 8, 0]} fill="var(--chart-1)" barSize={16} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Tile>
    </div>
  )
}
