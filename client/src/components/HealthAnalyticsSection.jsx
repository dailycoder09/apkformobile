import {
  Bar as RechartsBar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { Tile, TileLabel } from './PageShell'

const tip = {
  contentStyle: {
    borderRadius: 12,
    border: '1px solid var(--color-border)',
    background: 'var(--color-popover)',
    fontSize: 12,
  },
}

// --color-success / --color-warning / --color-destructive are static tokens from
// tailwind.css's @theme block, never rewritten by applyTheme() at runtime — see
// HealthTrackerPanel.jsx's matching comment. --chart-1 (bare, no --color- prefix) IS
// rewritten at runtime to track the live gold theme, so the neutral/gold series below
// reads that CSS var directly instead of a hardcoded value (same convention Dashboard.jsx
// uses for its own gold-toned charts).
const SUCCESS_COLOR = 'oklch(0.55 0.115 158)'
const WARNING_COLOR = 'oklch(0.68 0.13 62)'
const DESTRUCTIVE_COLOR = 'oklch(0.556 0.185 25)'

// Page 2 of the mobile split: read-only trends. Pure presentational, same data
// HealthTrackerPanel.jsx already computes — see HealthEpisodesSection.jsx for why this is a
// plain props-in component rather than owning any state of its own. Reused as-is (read-only,
// there being nothing to make read-only here in the first place) by AdminHealthView.jsx.
export default function HealthAnalyticsSection({
  episodes,
  episodesPerMonth,
  topSymptoms,
  severityBreakdown,
  avgRecoveryDays,
  recoveryBySeverity,
}) {
  return (
    <div className="px-1">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Tile>
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-lg text-gold">insights</span>
            <TileLabel>Episodes — Last 6 Months</TileLabel>
          </div>
          {episodes.length === 0 ? (
            <p className="mt-8 text-center text-sm text-muted-foreground">Log an episode to see your trend.</p>
          ) : (
            <div className="mt-2 h-[190px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={episodesPerMonth} barGap={6}>
                  <CartesianGrid strokeDasharray="3 6" stroke="var(--color-border)" vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={28} tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} />
                  <Tooltip {...tip} formatter={(v) => [`${v}`, 'Episodes']} />
                  <RechartsBar dataKey="count" name="Episodes" radius={[8, 8, 0, 0]} fill="var(--chart-1)" barSize={22} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Tile>

        <Tile>
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-lg text-gold">donut_small</span>
            <TileLabel>Severity Breakdown</TileLabel>
          </div>
          {episodes.length === 0 ? (
            <p className="mt-8 text-center text-sm text-muted-foreground">No episodes to break down yet.</p>
          ) : (
            <div className="mt-2 h-[190px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Tooltip {...tip} formatter={(v, n, entry) => [entry.payload.count, entry.payload.label]} />
                  <Pie data={severityBreakdown} dataKey="value" innerRadius={44} outerRadius={66} paddingAngle={4} stroke="none">
                    <Cell fill={SUCCESS_COLOR} />
                    <Cell fill={WARNING_COLOR} />
                    <Cell fill={DESTRUCTIVE_COLOR} />
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="mt-1 flex items-center justify-center gap-4 text-[11px] text-muted-foreground">
                {severityBreakdown.map(s => (
                  <span key={s.id} className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full" style={{ background: s.color }} />
                    {s.label} · {s.count}
                  </span>
                ))}
              </div>
            </div>
          )}
        </Tile>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Tile>
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-lg text-gold">sick</span>
            <TileLabel>Most Common Symptoms</TileLabel>
          </div>
          {topSymptoms.length === 0 ? (
            <p className="mt-8 text-center text-sm text-muted-foreground">No symptoms logged yet.</p>
          ) : (
            <div className="mt-2 h-[190px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topSymptoms} layout="vertical" margin={{ left: 8, right: 12 }}>
                  <CartesianGrid strokeDasharray="3 6" stroke="var(--color-border)" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} />
                  <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={84} tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }} />
                  <Tooltip {...tip} formatter={(v) => [`${v}`, 'Occurrences']} />
                  <RechartsBar dataKey="count" name="Occurrences" radius={[0, 8, 8, 0]} fill="var(--chart-1)" barSize={16} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Tile>

        <Tile>
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-lg text-gold">healing</span>
            <TileLabel>Recovery Time</TileLabel>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <p className="num text-2xl font-extrabold text-foreground">{avgRecoveryDays}<span className="text-base font-medium text-muted-foreground"> days avg</span></p>
          </div>
          {episodes.filter(e => e.recoveryDate != null).length === 0 ? (
            <p className="mt-6 text-center text-sm text-muted-foreground">No resolved episodes yet.</p>
          ) : (
            <div className="mt-1 h-[140px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={recoveryBySeverity} barGap={6}>
                  <CartesianGrid strokeDasharray="3 6" stroke="var(--color-border)" vertical={false} />
                  <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={28} tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} />
                  <Tooltip {...tip} formatter={(v) => [`${v}d`, 'Avg recovery']} />
                  <RechartsBar dataKey="days" name="Avg days" radius={[8, 8, 0, 0]} barSize={26}>
                    <Cell fill={SUCCESS_COLOR} />
                    <Cell fill={WARNING_COLOR} />
                    <Cell fill={DESTRUCTIVE_COLOR} />
                  </RechartsBar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Tile>
      </div>
    </div>
  )
}
