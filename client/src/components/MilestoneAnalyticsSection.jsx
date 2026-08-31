import {
  Area, AreaChart, Bar as RechartsBar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { Tile, TileLabel, Bar } from './PageShell'
import { Badge3D } from './Celebrate'

// Recharts tooltip styling shared by every chart on this page, matching MilestonePanel.jsx's
// own `tip` constant exactly before the split (khata.tsx / milestones.tsx both define the
// same object) — duplicated here rather than imported since it's only needed by charts,
// which all now live in this file.
const tip = {
  contentStyle: {
    borderRadius: 12,
    border: '1px solid var(--color-border)',
    background: 'var(--color-popover)',
    fontSize: 12,
  },
}

// Page 2 of the mobile split: motivation score, charts and badges — read-only analytics,
// same data MilestonePanel.jsx already computes. Pure presentational, same props-in
// philosophy as MilestoneAgendaSection.jsx / KhatabookAnalyticsSection.jsx.
export default function MilestoneAnalyticsSection(props) {
  return (
    <div className="px-1">
      <MobileFlat {...props} />
      <DesktopCards {...props} />
    </div>
  )
}

// ── Mobile: flat page, no card panels — sections separated by dividers/spacing only. ──
function MobileFlat({
  activeMilestoneStats,
  trendData,
  breakdownData,
  goalChartData,
  perMilestoneChartData,
  globalBadges,
}) {
  return (
    <div className="md:hidden">
      <div className="border-b border-foreground/12 pb-4">
        <TileLabel>Motivation Score</TileLabel>
        <p className="num mt-2 text-3xl font-extrabold text-gradient-gold">
          {activeMilestoneStats?.motivationScore ?? 0}<span className="text-sm font-medium text-muted-foreground">/100</span>
        </p>
        <div className="mt-3">
          <Bar value={activeMilestoneStats?.motivationScore ?? 0} tone="gold" />
        </div>
      </div>

      <div className="mt-4 border-b border-foreground/12 pb-4">
        <TileLabel>Completion Trend</TileLabel>
        <div className="mt-3 h-[160px]">
          {!trendData ? (
            <p className="mt-8 text-center text-sm text-muted-foreground">Check back tomorrow to see your trend.</p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trendData}>
                <defs>
                  <linearGradient id="msTrendMobile" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-gold)" stopOpacity={0.6} />
                    <stop offset="100%" stopColor="var(--color-gold)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Tooltip {...tip} formatter={(v) => `${v}%`} />
                <Area type="monotone" dataKey="pct" stroke="var(--color-gold)" strokeWidth={2.5} fill="url(#msTrendMobile)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="mt-4 border-b border-foreground/12 pb-4">
        <TileLabel>Today's Breakdown</TileLabel>
        <div className="mt-2 h-[160px]">
          {!breakdownData ? (
            <p className="mt-8 text-center text-sm text-muted-foreground">No tasks planned yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Tooltip {...tip} />
                <Pie data={breakdownData} dataKey="value" innerRadius={40} outerRadius={60} paddingAngle={4} stroke="none">
                  <Cell fill="var(--color-gold)" />
                  <Cell fill="var(--color-secondary)" />
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
        <p className="num text-center text-xs text-muted-foreground">
          {activeMilestoneStats?.todayDone ?? 0} done · {Math.max(0, (activeMilestoneStats?.todayTotal ?? 0) - (activeMilestoneStats?.todayDone ?? 0))} remaining
        </p>
      </div>

      <div className="mt-4 border-b border-foreground/12 pb-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-base text-gold">target</span>
          <TileLabel>Goal progress vs today's tasks</TileLabel>
        </div>
        <div className="mt-3 h-[200px]">
          {goalChartData.length === 0 ? (
            <p className="mt-8 text-center text-sm text-muted-foreground">No goals in this milestone yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={goalChartData} barGap={6}>
                <CartesianGrid strokeDasharray="3 6" stroke="var(--color-border)" vertical={false} />
                <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} />
                <YAxis domain={[0, 100]} tickLine={false} axisLine={false} width={30} tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} />
                <Tooltip {...tip} formatter={(v) => `${v}%`} />
                <RechartsBar dataKey="goal" name="Goal %" radius={[6, 6, 0, 0]} fill="var(--chart-1)" barSize={16} />
                <RechartsBar dataKey="tasks" name="Today's tasks %" radius={[6, 6, 0, 0]} fill="var(--chart-2)" barSize={16} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="mt-4 border-b border-foreground/12 pb-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-base text-gold">rocket_launch</span>
          <TileLabel>Progress vs motivation by milestone</TileLabel>
        </div>
        <div className="mt-3 h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={perMilestoneChartData} barGap={6}>
              <CartesianGrid strokeDasharray="3 6" stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} />
              <YAxis domain={[0, 100]} tickLine={false} axisLine={false} width={30} tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} />
              <Tooltip {...tip} formatter={(v) => `${v}%`} />
              <RechartsBar dataKey="progress" name="Progress %" radius={[6, 6, 0, 0]} fill="var(--chart-1)" barSize={18} />
              <RechartsBar dataKey="motivation" name="Motivation %" radius={[6, 6, 0, 0]} fill="var(--chart-2)" barSize={18} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="mt-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-base text-gold">military_tech</span>
          <TileLabel>Achievement Badges</TileLabel>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {globalBadges.map(b => (
            <Badge3D key={b.id} title={b.label} hint={b.hint} earned={b.earned} icon={<span className="material-symbols-outlined text-base">{b.icon}</span>} />
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Desktop: original boxed-Tile treatment, unchanged. ──
function DesktopCards({
  activeMilestoneStats,
  trendData,
  breakdownData,
  goalChartData,
  perMilestoneChartData,
  globalBadges,
}) {
  return (
    <div className="hidden md:block">
      <div className="grid grid-cols-1 gap-4 stagger md:grid-cols-6">
        <Tile className="col-span-1 md:col-span-2">
          <TileLabel>Motivation Score</TileLabel>
          <p className="num mt-3 text-4xl font-extrabold text-gradient-gold">
            {activeMilestoneStats?.motivationScore ?? 0}<span className="text-base text-muted-foreground">/100</span>
          </p>
          <div className="mt-4">
            <Bar value={activeMilestoneStats?.motivationScore ?? 0} tone="gold" />
          </div>
          <p className="mt-4 text-xs text-muted-foreground">Live score from goal progress and how many daily tasks you ticked today.</p>
        </Tile>

        <Tile className="col-span-1 md:col-span-2">
          <TileLabel>Completion Trend</TileLabel>
          <div className="mt-4 h-[170px]">
            {!trendData ? (
              <p className="mt-8 text-center text-sm text-muted-foreground">Check back tomorrow to see your trend.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trendData}>
                  <defs>
                    <linearGradient id="msTrend" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-gold)" stopOpacity={0.6} />
                      <stop offset="100%" stopColor="var(--color-gold)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Tooltip {...tip} formatter={(v) => `${v}%`} />
                  <Area type="monotone" dataKey="pct" stroke="var(--color-gold)" strokeWidth={2.5} fill="url(#msTrend)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Tile>

        <Tile className="col-span-1 md:col-span-2">
          <TileLabel>Today's Breakdown</TileLabel>
          <div className="mt-2 h-[170px]">
            {!breakdownData ? (
              <p className="mt-8 text-center text-sm text-muted-foreground">No tasks planned yet.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Tooltip {...tip} />
                  <Pie data={breakdownData} dataKey="value" innerRadius={44} outerRadius={66} paddingAngle={4} stroke="none">
                    <Cell fill="var(--color-gold)" />
                    <Cell fill="var(--color-secondary)" />
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
          <p className="num text-center text-xs text-muted-foreground">
            {activeMilestoneStats?.todayDone ?? 0} done · {Math.max(0, (activeMilestoneStats?.todayTotal ?? 0) - (activeMilestoneStats?.todayDone ?? 0))} remaining
          </p>
        </Tile>

        <Tile className="col-span-1 md:col-span-3">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-lg text-gold">target</span>
            <TileLabel>Goal progress vs today's tasks</TileLabel>
          </div>
          <div className="mt-4 h-[220px]">
            {goalChartData.length === 0 ? (
              <p className="mt-8 text-center text-sm text-muted-foreground">No goals in this milestone yet.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={goalChartData} barGap={6}>
                  <CartesianGrid strokeDasharray="3 6" stroke="var(--color-border)" vertical={false} />
                  <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} />
                  <YAxis domain={[0, 100]} tickLine={false} axisLine={false} width={34} tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} />
                  <Tooltip {...tip} formatter={(v) => `${v}%`} />
                  <RechartsBar dataKey="goal" name="Goal %" radius={[8, 8, 0, 0]} fill="var(--chart-1)" barSize={18} />
                  <RechartsBar dataKey="tasks" name="Today's tasks %" radius={[8, 8, 0, 0]} fill="var(--chart-2)" barSize={18} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Tile>

        <Tile className="col-span-1 md:col-span-3">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-lg text-gold">rocket_launch</span>
            <TileLabel>Progress vs motivation by milestone</TileLabel>
          </div>
          <div className="mt-4 h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={perMilestoneChartData} barGap={6}>
                <CartesianGrid strokeDasharray="3 6" stroke="var(--color-border)" vertical={false} />
                <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }} />
                <YAxis domain={[0, 100]} tickLine={false} axisLine={false} width={34} tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} />
                <Tooltip {...tip} formatter={(v) => `${v}%`} />
                <RechartsBar dataKey="progress" name="Progress %" radius={[8, 8, 0, 0]} fill="var(--chart-1)" barSize={20} />
                <RechartsBar dataKey="motivation" name="Motivation %" radius={[8, 8, 0, 0]} fill="var(--chart-2)" barSize={20} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Tile>

        <Tile className="col-span-1 md:col-span-6">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-lg text-gold">military_tech</span>
            <TileLabel>Achievement Badges</TileLabel>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {globalBadges.map(b => (
              <Badge3D key={b.id} title={b.label} hint={b.hint} earned={b.earned} icon={<span className="material-symbols-outlined text-lg">{b.icon}</span>} />
            ))}
          </div>
        </Tile>
      </div>
    </div>
  )
}
