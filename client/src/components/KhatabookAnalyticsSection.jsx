import {
  Area, AreaChart, Bar as RechartsBar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { Tile, TileLabel, Bar } from './PageShell'
import { Badge3D } from './Celebrate'
import { formatINR, formatINRCompact } from '../utils/khataFormat'

const tip = {
  contentStyle: {
    borderRadius: 12,
    border: '1px solid var(--color-border)',
    background: 'var(--color-popover)',
    fontSize: 12,
  },
}

// --color-success / --color-destructive are static tokens from tailwind.css's @theme block,
// never rewritten by applyTheme() at runtime — see KhatabookPanel.jsx's matching comment.
const SUCCESS_COLOR = 'oklch(0.55 0.115 158)'
const DESTRUCTIVE_COLOR = 'oklch(0.556 0.185 25)'

// Page 2 of the mobile split: settlement score, charts and badges. Pure presentational, same
// data KhatabookPanel.jsx already computes — see KhatabookEntriesSection.jsx for why this is
// a plain props-in component rather than owning any state of its own.
export default function KhatabookAnalyticsSection({
  settleScore,
  settledCount,
  contacts,
  entries,
  totals,
  pieData,
  selectedContact,
  selectedBalance,
  balanceFlow,
  topContacts,
  sixMonthTrend,
  badges,
}) {
  return (
    <div className="px-1">
      {/* Settlement score + receivable/payable split — always visible, no toggle. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Tile>
          <TileLabel>Settlement Score</TileLabel>
          <p className="num mt-3 text-4xl font-extrabold text-gradient-gold">
            {settleScore}<span className="text-base font-medium text-muted-foreground">/100</span>
          </p>
          <div className="mt-4">
            <Bar value={settleScore} tone="gold" />
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            {settledCount} of {contacts.length} accounts fully cleared · {entries.length} entries logged.
          </p>
        </Tile>

        <Tile>
          <TileLabel>Receivable vs Payable</TileLabel>
          {totals.youllGet === 0 && totals.youllPay === 0 ? (
            <p className="mt-8 text-center text-sm text-muted-foreground">No balances to show yet.</p>
          ) : (
            <div className="mt-2 h-[170px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Tooltip {...tip} formatter={(v) => formatINR(v)} />
                  <Pie data={pieData} dataKey="value" innerRadius={44} outerRadius={66} paddingAngle={4} stroke="none">
                    <Cell fill={SUCCESS_COLOR} />
                    <Cell fill={DESTRUCTIVE_COLOR} />
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </Tile>
      </div>

      {/* Balance flow (selected contact) + biggest open balances across everyone. */}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Tile>
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-lg text-gold">trending_up</span>
            <TileLabel>{selectedContact ? `${selectedContact.name}'s Balance Flow` : 'Balance Flow'}</TileLabel>
          </div>
          {!selectedContact ? (
            <p className="mt-8 text-center text-sm text-muted-foreground">Select a contact above to see their balance flow.</p>
          ) : balanceFlow.length === 0 ? (
            <p className="mt-8 text-center text-sm text-muted-foreground">No entries yet for {selectedContact.name}.</p>
          ) : (
            <>
              {/* Headline number does the communicating even when there are only 2-3
                  points — a bare line/area with no axis or dots read as an empty
                  triangle, especially with this little data. */}
              <div className="mt-3 flex items-baseline gap-2">
                <p className={`num text-2xl font-extrabold ${selectedBalance > 0 ? 'text-success' : selectedBalance < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {formatINR(Math.abs(selectedBalance))}
                </p>
                <p className="text-xs text-muted-foreground">
                  {selectedBalance === 0 ? 'settled' : selectedBalance > 0 ? 'they owe you' : 'you owe them'}
                </p>
              </div>
              <div className="mt-1 h-[150px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart key={selectedContact.id} data={balanceFlow} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
                    <defs>
                      <linearGradient id="khataFlow" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={selectedBalance >= 0 ? SUCCESS_COLOR : DESTRUCTIVE_COLOR} stopOpacity={0.5} />
                        <stop offset="100%" stopColor={selectedBalance >= 0 ? SUCCESS_COLOR : DESTRUCTIVE_COLOR} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    {/* Domain always includes 0 (with padding) so the reference line below
                        is never clipped off-screen, whichever side of zero the balance sits on. */}
                    <YAxis
                      hide
                      domain={[
                        (dataMin) => Math.min(0, dataMin) - (Math.abs(dataMin) * 0.15 || 10),
                        (dataMax) => Math.max(0, dataMax) + (Math.abs(dataMax) * 0.15 || 10),
                      ]}
                    />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} />
                    <ReferenceLine y={0} stroke="var(--color-muted-foreground)" strokeDasharray="4 4" strokeOpacity={0.6} />
                    <Tooltip {...tip} formatter={(v) => formatINR(v)} />
                    <Area
                      type="stepAfter"
                      dataKey="balance"
                      stroke={selectedBalance >= 0 ? SUCCESS_COLOR : DESTRUCTIVE_COLOR}
                      strokeWidth={2.5}
                      fill="url(#khataFlow)"
                      dot={{ r: 3.5, strokeWidth: 0, fill: selectedBalance >= 0 ? SUCCESS_COLOR : DESTRUCTIVE_COLOR }}
                      activeDot={{ r: 5 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </Tile>

        <Tile>
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-lg text-gold">handshake</span>
            <TileLabel>Biggest Open Balances</TileLabel>
          </div>
          {topContacts.length === 0 ? (
            <p className="mt-8 text-center text-sm text-muted-foreground">No open balances yet.</p>
          ) : (
            <div className="mt-2 h-[210px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topContacts} barGap={6}>
                  <CartesianGrid strokeDasharray="3 6" stroke="var(--color-border)" vertical={false} />
                  <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }} />
                  <YAxis tickFormatter={formatINRCompact} tickLine={false} axisLine={false} width={48} tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} />
                  <Tooltip {...tip} formatter={(v) => formatINR(v)} />
                  <RechartsBar dataKey="owed" name="You'll get" radius={[8, 8, 0, 0]} fill={SUCCESS_COLOR} barSize={18} />
                  <RechartsBar dataKey="owe" name="You'll pay" radius={[8, 8, 0, 0]} fill={DESTRUCTIVE_COLOR} barSize={18} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Tile>
      </div>

      {/* Given vs got, real 6-month trend. */}
      <Tile className="mt-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-lg text-gold">insights</span>
          <TileLabel>Given vs Got — Last 6 Months</TileLabel>
        </div>
        {entries.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">Log entries to see your trend.</p>
        ) : (
          <div className="mt-2 h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={sixMonthTrend} barGap={6}>
                <CartesianGrid strokeDasharray="3 6" stroke="var(--color-border)" vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }} />
                <YAxis tickFormatter={formatINRCompact} tickLine={false} axisLine={false} width={48} tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} />
                <Tooltip {...tip} formatter={(v) => formatINR(v)} />
                <RechartsBar dataKey="gave" name="You gave" radius={[8, 8, 0, 0]} fill={DESTRUCTIVE_COLOR} barSize={22} />
                <RechartsBar dataKey="got" name="You got" radius={[8, 8, 0, 0]} fill={SUCCESS_COLOR} barSize={22} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Tile>

      {/* Badges — all four always shown, dimmed until earned. */}
      <Tile className="mt-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-lg text-gold">military_tech</span>
          <TileLabel>Badges</TileLabel>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {badges.map(b => (
            <Badge3D
              key={b.id}
              title={b.label}
              hint={b.hint}
              earned={b.earned}
              icon={<span className="material-symbols-outlined text-base">{b.icon}</span>}
            />
          ))}
        </div>
      </Tile>
    </div>
  )
}
