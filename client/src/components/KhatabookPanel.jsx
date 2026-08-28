import { useState, useEffect, useMemo } from 'react'
import {
  Area, AreaChart, Bar as RechartsBar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { PageShell, Tile, TileLabel, Stat, Bar } from './PageShell'
import { Celebrate, Badge3D } from './Celebrate'

// Recharts tooltip styling shared by every chart on this page — same `tip` constant as
// MilestonePanel.jsx / the reference app's khata.tsx.
const tip = {
  contentStyle: {
    borderRadius: 12,
    border: '1px solid var(--color-border)',
    background: 'var(--color-popover)',
    fontSize: 12,
  },
}

// Same "don't trust the browser's own timezone" pattern already used in TransactionPanel.jsx
// / AdminTransactionView.jsx / MilestonePanel.jsx — duplicated rather than shared, matching
// how those files each keep their own copy rather than a shared util (see project conventions).
const IST_TZ = 'Asia/Kolkata'
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
function istDateKey(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: IST_TZ }) // YYYY-MM-DD
}
function istDateInputToMs(dateStr) {
  return new Date(`${dateStr}T00:00:00+05:30`).getTime()
}
// Start of the IST calendar month `n` months before the one containing `ms` — same helper
// as TransactionPanel.jsx's sixMonthTrend, used here to build the "Given vs Got" trend.
function istMonthStartMinus(ms, n) {
  const s = new Date(ms + IST_OFFSET_MS)
  return Date.UTC(s.getUTCFullYear(), s.getUTCMonth() - n, 1) - IST_OFFSET_MS
}
function formatINR(n) {
  return '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function formatDate(ms) {
  return new Date(ms).toLocaleDateString('en-IN', { timeZone: IST_TZ, day: 'numeric', month: 'short', year: 'numeric' })
}
// Short form (no year) for compact contexts — the accounts list's "last activity" line and
// chart axis labels, where a full date would just wrap/clip.
function formatShortDate(ms) {
  return new Date(ms).toLocaleDateString('en-IN', { timeZone: IST_TZ, day: 'numeric', month: 'short' })
}
// Abbreviated ₹ form for cramped chart-axis ticks (e.g. ₹1.2k, ₹3.4L) — formatINR's full
// "₹1,234.56" is too wide for a 48px-wide YAxis.
function formatINRCompact(n) {
  const v = Number(n)
  const abs = Math.abs(v)
  if (abs >= 100000) return '₹' + (v / 100000).toFixed(1) + 'L'
  if (abs >= 1000) return '₹' + (v / 1000).toFixed(1) + 'k'
  return '₹' + Math.round(v)
}

// --color-success / --color-destructive are static tokens straight from tailwind.css's
// @theme block — applyTheme() (utils/theme.js) only ever rewrites --color-gold, the
// --chart-1..5 scale, and the light/dark neutrals at runtime, never these two. Hardcoding
// their known oklch values here is therefore equivalent to reading the "resolved" CSS
// variable, matching the reference app's var(--success)/var(--destructive) chart fills.
const SUCCESS_COLOR = 'oklch(0.55 0.115 158)'
const DESTRUCTIVE_COLOR = 'oklch(0.556 0.185 25)'

const EMPTY_CONTACT_FORM = { id: null, name: '', phone: '', note: '' }
const EMPTY_ENTRY_FORM = { id: null, type: 'gave', amount: '', note: '', date: '' }

// Personal ledger of informal money lent to / borrowed from people — separate from the
// bank-statement-driven Finance screen. Self-service only: contacts/entries are arbitrary
// free-text people, not linked to real FamilyWatch accounts, and this data is never
// surfaced to a parent's admin view (unlike transactions/budgets).
export default function KhatabookPanel({ session, sendMsg, addListener, onHome }) {
  const [contacts, setContacts] = useState([])
  const [entries, setEntries] = useState([])
  const [selectedContactId, setSelectedContactId] = useState(null)

  const [contactSheetOpen, setContactSheetOpen] = useState(false)
  const [contactForm, setContactForm] = useState(EMPTY_CONTACT_FORM)

  const [entrySheetMode, setEntrySheetMode] = useState(null) // null | 'add' | 'edit'
  const [entryForm, setEntryForm] = useState(EMPTY_ENTRY_FORM)

  // Confetti trigger for the shared <Celebrate> banner — same `{n: timestamp, msg}` pattern
  // as the reference app's khata.tsx, bumped from submitEntry() below whenever a contact's
  // recalculated balance transitions from nonzero to exactly 0.
  const [cheer, setCheer] = useState({ n: 0, msg: '' })

  useEffect(() => {
    return addListener((msg) => {
      if (msg.type === 'ledger_data') {
        setContacts(msg.contacts || [])
        setEntries(msg.entries || [])
      }
    })
  }, [addListener])

  useEffect(() => {
    sendMsg({ type: 'ledger_data_get' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Per-contact balance: positive = they owe the user ("You'll Get"), negative = the user
  // owes them ("You'll Pay"). "gave" = money the user handed over (increases what's owed
  // back to the user); "got" = money the user received/borrowed (increases what the user
  // owes back).
  const balances = useMemo(() => {
    const map = {}
    entries.forEach(e => {
      const delta = e.type === 'gave' ? e.amount : -e.amount
      map[e.contactId] = (map[e.contactId] || 0) + delta
    })
    return map
  }, [entries])

  // Summed separately (not netted against each other) — a contact who owes the user
  // shouldn't cancel out against a different contact the user owes money to.
  const totals = useMemo(() => {
    let youllGet = 0, youllPay = 0
    contacts.forEach(c => {
      const bal = balances[c.id] || 0
      if (bal > 0) youllGet += bal
      else youllPay += -bal
    })
    return { youllGet, youllPay }
  }, [contacts, balances])

  const sortedContacts = useMemo(
    () => [...contacts].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    [contacts]
  )

  // Falls back to the first (most recent) contact when nothing has been explicitly
  // clicked yet — mirrors the reference app's `list.find(...) ?? list[0]`, so the detail
  // card/charts always show something meaningful instead of an empty "select a contact"
  // state on first load.
  const selectedContact = contacts.find(c => c.id === selectedContactId) || sortedContacts[0] || null
  const selectedEntries = useMemo(
    () => entries.filter(e => e.contactId === selectedContact?.id).sort((a, b) => b.date - a.date),
    [entries, selectedContact]
  )
  const selectedBalance = selectedContact ? (balances[selectedContact.id] || 0) : 0

  // How many contacts currently have zero balance — used both for the stat strip's
  // "Contacts" hint and the Settlement Score tile below.
  const settledCount = useMemo(() => contacts.filter(c => (balances[c.id] || 0) === 0).length, [contacts, balances])
  const settleScore = contacts.length ? Math.round((settledCount / contacts.length) * 100) : 0
  const positiveCount = useMemo(() => contacts.filter(c => (balances[c.id] || 0) > 0).length, [contacts, balances])
  const negativeCount = useMemo(() => contacts.filter(c => (balances[c.id] || 0) < 0).length, [contacts, balances])

  // Receivable vs payable donut — a small floor value on each slice keeps the pie from
  // collapsing to a single sliver when one side is exactly zero (same trick the reference
  // design uses: Math.max(value, 0.001)).
  const pieData = useMemo(() => ([
    { id: 0, label: "You'll get", value: Math.max(totals.youllGet, 0.01), color: SUCCESS_COLOR },
    { id: 1, label: "You'll pay", value: Math.max(totals.youllPay, 0.01), color: DESTRUCTIVE_COLOR },
  ]), [totals])

  // Running cumulative balance for the selected contact, oldest entry first — the "Balance
  // Flow" line chart below reads left-to-right as a timeline, so it needs ascending order
  // even though the entry list itself (selectedEntries above) stays newest-first.
  const balanceFlow = useMemo(() => {
    const asc = [...selectedEntries].sort((a, b) => a.date - b.date)
    let cum = 0
    return asc.map(e => {
      cum += e.type === 'gave' ? e.amount : -e.amount
      return { label: formatShortDate(e.date), balance: cum }
    })
  }, [selectedEntries])

  // Top 5 contacts by absolute balance, split into "owed to you" / "owed by you" so a
  // grouped bar chart can show both bars per person.
  const topContacts = useMemo(() => {
    return contacts
      .map(c => ({ name: c.name.split(' ')[0] || c.name, balance: balances[c.id] || 0 }))
      .filter(c => c.balance !== 0)
      .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance))
      .slice(0, 5)
      .map(c => ({ name: c.name, owed: Math.max(0, c.balance), owe: Math.abs(Math.min(0, c.balance)) }))
  }, [contacts, balances])

  // Real 6-month "given vs got" trend, aggregated from actual entries (not placeholder
  // data) — same full-calendar-month bucketing as TransactionPanel.jsx's sixMonthTrend.
  const sixMonthTrend = useMemo(() => {
    const months = []
    for (let i = 5; i >= 0; i--) {
      const start = istMonthStartMinus(Date.now(), i)
      const end = istMonthStartMinus(Date.now(), i - 1)
      const inRange = entries.filter(e => e.date >= start && e.date < end)
      const gave = inRange.filter(e => e.type === 'gave').reduce((s, e) => s + e.amount, 0)
      const got = inRange.filter(e => e.type === 'got').reduce((s, e) => s + e.amount, 0)
      const label = new Date(start).toLocaleDateString('en-IN', { timeZone: IST_TZ, month: 'short' })
      months.push({ label, gave, got })
    }
    return months
  }, [entries])

  const badges = useMemo(() => ([
    { id: 'first', label: 'First Entry', hint: 'Log your first entry', icon: 'receipt_long', earned: entries.length > 0 },
    { id: 'settler', label: 'Settler', hint: 'Clear one account fully', icon: 'verified', earned: contacts.some(c => (balances[c.id] || 0) === 0 && entries.some(e => e.contactId === c.id)) },
    { id: 'trusted', label: 'Trusted Circle', hint: 'Track 4+ contacts', icon: 'groups', earned: contacts.length >= 4 },
    { id: 'clean', label: 'Clean Books', hint: 'All accounts settled', icon: 'emoji_events', earned: contacts.length > 0 && contacts.every(c => (balances[c.id] || 0) === 0) },
  ]), [contacts, entries, balances])

  function openAddContact() {
    setContactForm(EMPTY_CONTACT_FORM)
    setContactSheetOpen(true)
  }

  function openEditContact(contact) {
    setContactForm({ id: contact.id, name: contact.name, phone: contact.phone || '', note: contact.note || '' })
    setContactSheetOpen(true)
  }

  function submitContact() {
    const name = contactForm.name.trim()
    if (!name) return
    if (contactForm.id) {
      const existing = contacts.find(c => c.id === contactForm.id)
      const updated = { ...existing, id: contactForm.id, name, phone: contactForm.phone.trim(), note: contactForm.note.trim() }
      setContacts(prev => prev.map(c => c.id === updated.id ? updated : c))
      sendMsg({ type: 'ledger_contact_update', contact: updated })
    } else {
      const contact = {
        id: Math.random().toString(36).slice(2),
        name,
        phone: contactForm.phone.trim(),
        note: contactForm.note.trim(),
        createdAt: Date.now(),
      }
      setContacts(prev => [contact, ...prev])
      sendMsg({ type: 'ledger_contact_add', contact })
    }
    setContactSheetOpen(false)
  }

  function deleteContact(id) {
    setContacts(prev => prev.filter(c => c.id !== id))
    setEntries(prev => prev.filter(e => e.contactId !== id))
    sendMsg({ type: 'ledger_contact_delete', id })
    if (selectedContactId === id) setSelectedContactId(null)
  }

  function openAddEntry() {
    setEntryForm({ ...EMPTY_ENTRY_FORM, date: istDateKey(Date.now()) })
    setEntrySheetMode('add')
  }

  function openEditEntry(entry) {
    setEntryForm({
      id: entry.id,
      type: entry.type,
      amount: String(entry.amount),
      note: entry.note || '',
      date: istDateKey(entry.date),
    })
    setEntrySheetMode('edit')
  }

  function submitEntry() {
    const amount = parseFloat(entryForm.amount)
    const contactId = selectedContact?.id
    if (!amount || amount <= 0 || !contactId) return
    const dateMs = entryForm.date ? istDateInputToMs(entryForm.date) : Date.now()
    const prevBalance = selectedBalance
    let nextEntries
    if (entrySheetMode === 'edit') {
      const updated = { id: entryForm.id, contactId, type: entryForm.type, amount, note: entryForm.note.trim(), date: dateMs }
      nextEntries = entries.map(e => e.id === updated.id ? updated : e)
      setEntries(nextEntries)
      sendMsg({ type: 'ledger_entry_update', entry: updated })
    } else {
      const entry = { id: Math.random().toString(36).slice(2), contactId, type: entryForm.type, amount, note: entryForm.note.trim(), date: dateMs }
      nextEntries = [entry, ...entries]
      setEntries(nextEntries)
      sendMsg({ type: 'ledger_entry_add', entry })
    }
    // Celebrate a contact's balance reaching exactly 0 — mirrors the reference khata.tsx's
    // `cheer` bump inside its saveEntry().
    const nextBalance = nextEntries
      .filter(e => e.contactId === contactId)
      .reduce((s, e) => s + (e.type === 'gave' ? e.amount : -e.amount), 0)
    if (nextBalance === 0 && prevBalance !== 0 && selectedContact) {
      setCheer({ n: Date.now(), msg: `${selectedContact.name} is fully settled!` })
    }
    setEntrySheetMode(null)
  }

  function deleteEntry(id) {
    setEntries(prev => prev.filter(e => e.id !== id))
    sendMsg({ type: 'ledger_entry_delete', id })
    setEntrySheetMode(null)
  }

  // Net "You'll Get minus You'll Pay" figure shown in the PageShell header's action pill —
  // mirrors the reference khata.tsx's receivable-payable net position stat.
  const netPosition = totals.youllGet - totals.youllPay

  return (
    // `khata-screen` is kept on this outer wrapper (rather than merged into PageShell's own
    // root div) purely as a CSS targeting hook — index.css's global margin/padding reset and
    // the add-txn-sheet color overrides both key off `.khata-screen` / `.khata-screen *`.
    // PageShell itself renders the actual `surface-sand` scroll container inside.
    <div className="khata-screen font-sans">
      <PageShell
        eyebrow="Module 03"
        title="Khatabook"
        lead="Track money you lend and borrow — add, edit and settle every rupee, with analytics and badges for clean books."
        onHome={selectedContact ? () => setSelectedContactId(null) : onHome}
        back={true}
        action={
          <div className="tile-static shrink-0 px-5 py-3 text-right">
            <p className={`num text-2xl font-extrabold ${netPosition >= 0 ? 'text-success' : 'text-destructive'}`}>
              {netPosition < 0 ? '−' : ''}{formatINR(Math.abs(netPosition))}
            </p>
            <p className="text-[11px] text-muted-foreground">net position</p>
          </div>
        }
      >
        <Celebrate show={cheer.n > 0} message={cheer.msg} key={cheer.n} />

        <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat
            label="You'll Get"
            value={formatINR(totals.youllGet)}
            hint={`${positiveCount} contact${positiveCount !== 1 ? 's' : ''}`}
            tone="success"
            icon={<span className="material-symbols-outlined text-base">call_received</span>}
          />
          <Stat
            label="You'll Pay"
            value={formatINR(totals.youllPay)}
            hint={`${negativeCount} contact${negativeCount !== 1 ? 's' : ''}`}
            tone="danger"
            icon={<span className="material-symbols-outlined text-base">call_made</span>}
          />
          <Stat
            label="Contacts"
            value={String(contacts.length)}
            hint={`${settledCount} settled`}
            tone="gold"
            icon={<span className="material-symbols-outlined text-base">group</span>}
          />
        </div>

        {/* Accounts list — always visible, independent of whether a contact is selected,
            so tapping between people below doesn't require navigating away and back. */}
        <Tile className="mt-4">
          <div className="flex items-center justify-between gap-3">
            <TileLabel>Accounts</TileLabel>
            <button
              type="button"
              onClick={openAddContact}
              className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-[image:var(--gradient-gold)] px-3 text-xs font-semibold text-white transition-opacity hover:opacity-90"
            >
              <span className="material-symbols-outlined text-base">add</span> Add contact
            </button>
          </div>

          <div className="mt-3 flex flex-col gap-2">
            {sortedContacts.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <span className="material-symbols-outlined text-4xl text-muted-foreground">group_off</span>
                <p className="font-semibold text-foreground">No contacts yet</p>
                <p className="text-sm text-muted-foreground">Tap Add contact for someone you lend to or borrow from</p>
              </div>
            ) : sortedContacts.map(c => {
              const bal = balances[c.id] || 0
              const contactEntries = entries.filter(e => e.contactId === c.id)
              const lastEntry = contactEntries.reduce((latest, e) => (!latest || e.date > latest.date) ? e : latest, null)
              const selected = c.id === selectedContact?.id
              return (
                <div
                  key={c.id}
                  className={`flex items-center gap-2 rounded-2xl border p-3 transition-colors ${selected ? 'border-gold/40 bg-gold-soft' : 'border-border bg-secondary/40'}`}
                >
                  <button type="button" onClick={() => setSelectedContactId(c.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <span className="grid size-10 shrink-0 place-items-center rounded-full bg-card text-sm font-bold text-foreground">
                      {c.name.charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-foreground">{c.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {lastEntry ? `${formatShortDate(lastEntry.date)} · ${contactEntries.length} ${contactEntries.length !== 1 ? 'entries' : 'entry'}` : 'No entries yet'}
                      </span>
                    </span>
                    <span className={`num shrink-0 text-sm font-bold ${bal > 0 ? 'text-success' : bal < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                      {bal === 0 ? 'Settled' : formatINR(Math.abs(bal))}
                    </span>
                  </button>
                  <span className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      aria-label={`Edit ${c.name}`}
                      onClick={() => openEditContact(c)}
                      className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
                    >
                      <span className="material-symbols-outlined text-lg">edit</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${c.name}`}
                      onClick={() => deleteContact(c.id)}
                      className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive-soft hover:text-destructive"
                    >
                      <span className="material-symbols-outlined text-lg">delete</span>
                    </button>
                  </span>
                </div>
              )
            })}
          </div>
        </Tile>

        {/* Contact detail — only appears once a contact is selected from the list above. */}
        {selectedContact && (
          <Tile className="mt-4">
            <div className="flex items-center gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-[image:var(--gradient-gold)] text-base font-extrabold text-white">
                {selectedContact.name.charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-bold text-foreground">{selectedContact.name}</p>
                {(selectedContact.phone || selectedContact.note) && (
                  <p className="truncate text-xs text-muted-foreground">
                    {[selectedContact.phone, selectedContact.note].filter(Boolean).join(' · ')}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={openAddEntry}
                className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-secondary px-3 text-xs font-semibold text-foreground transition-colors hover:bg-secondary/70"
              >
                <span className="material-symbols-outlined text-base">add</span> Add entry
              </button>
            </div>

            <div className="mt-4 rounded-2xl bg-secondary p-5 text-center">
              <p className={`num text-3xl font-extrabold ${selectedBalance > 0 ? 'text-success' : selectedBalance < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                {formatINR(Math.abs(selectedBalance))}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {selectedBalance === 0 ? 'all settled' : selectedBalance > 0 ? 'they owe you' : 'you owe them'}
              </p>
            </div>

            <div className="mt-3 flex flex-col divide-y divide-border">
              {selectedEntries.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-10 text-center">
                  <span className="material-symbols-outlined text-4xl text-muted-foreground">receipt_long</span>
                  <p className="font-semibold text-foreground">No entries yet</p>
                  <p className="text-sm text-muted-foreground">Tap Add entry to log money given or received</p>
                </div>
              ) : selectedEntries.map(e => (
                <div key={e.id} className="flex items-center gap-3 py-3">
                  <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${e.type === 'gave' ? 'bg-destructive-soft text-destructive' : 'bg-success-soft text-success'}`}>
                    <span className="material-symbols-outlined text-lg">{e.type === 'gave' ? 'call_made' : 'call_received'}</span>
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-foreground">{e.type === 'gave' ? 'You gave' : 'You got'}</p>
                    <p className="truncate text-xs text-muted-foreground">{[e.note, formatDate(e.date)].filter(Boolean).join(' · ')}</p>
                  </div>
                  <p className={`num shrink-0 text-sm font-bold ${e.type === 'gave' ? 'text-destructive' : 'text-success'}`}>
                    {e.type === 'gave' ? '−' : '+'}{formatINR(e.amount)}
                  </p>
                  <span className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      aria-label="Edit entry"
                      onClick={() => openEditEntry(e)}
                      className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    >
                      <span className="material-symbols-outlined text-lg">edit</span>
                    </button>
                    <button
                      type="button"
                      aria-label="Delete entry"
                      onClick={() => deleteEntry(e.id)}
                      className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive-soft hover:text-destructive"
                    >
                      <span className="material-symbols-outlined text-lg">delete</span>
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </Tile>
        )}

        {/* Settlement score + receivable/payable split — always visible, no toggle. */}
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
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
              <div className="mt-2 h-[170px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart key={selectedContact.id} data={balanceFlow}>
                    <defs>
                      <linearGradient id="khataFlow" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={selectedBalance >= 0 ? SUCCESS_COLOR : DESTRUCTIVE_COLOR} stopOpacity={0.6} />
                        <stop offset="100%" stopColor={selectedBalance >= 0 ? SUCCESS_COLOR : DESTRUCTIVE_COLOR} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} />
                    <Tooltip {...tip} formatter={(v) => formatINR(v)} />
                    <Area
                      type="monotone"
                      dataKey="balance"
                      stroke={selectedBalance >= 0 ? SUCCESS_COLOR : DESTRUCTIVE_COLOR}
                      strokeWidth={2.5}
                      fill="url(#khataFlow)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
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
      </PageShell>

      {contactSheetOpen && (
        <div className="add-txn-overlay" onClick={e => e.target === e.currentTarget && setContactSheetOpen(false)}>
          <div className="add-txn-sheet">
            <div className="add-txn-header">
              <span>{contactForm.id ? 'Edit Contact' : 'Add Contact'}</span>
              <button className="add-txn-close" onClick={() => setContactSheetOpen(false)}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="add-field">
              <label className="add-label">Name</label>
              <input className="add-input" type="text" placeholder="e.g. Rahul"
                value={contactForm.name} onChange={e => setContactForm(f => ({ ...f, name: e.target.value }))} autoFocus />
            </div>
            <div className="add-field">
              <label className="add-label">Phone (optional)</label>
              <input className="add-input" type="tel" placeholder="e.g. 98765 43210"
                value={contactForm.phone} onChange={e => setContactForm(f => ({ ...f, phone: e.target.value }))} />
            </div>
            <div className="add-field">
              <label className="add-label">Note (optional)</label>
              <input className="add-input" type="text" placeholder="e.g. Friend, colleague"
                value={contactForm.note} onChange={e => setContactForm(f => ({ ...f, note: e.target.value }))} />
            </div>

            <button className="add-txn-submit" onClick={submitContact} disabled={!contactForm.name.trim()}>
              {contactForm.id ? 'Save Changes' : 'Add Contact'}
            </button>
            {contactForm.id && (
              <button className="add-txn-delete" onClick={() => { deleteContact(contactForm.id); setContactSheetOpen(false) }}>
                Delete Contact
              </button>
            )}
          </div>
        </div>
      )}

      {entrySheetMode && (
        <div className="add-txn-overlay" onClick={e => e.target === e.currentTarget && setEntrySheetMode(null)}>
          <div className="add-txn-sheet">
            <div className="add-txn-header">
              <span>{entrySheetMode === 'edit' ? 'Edit Entry' : 'Add Entry'}</span>
              <button className="add-txn-close" onClick={() => setEntrySheetMode(null)}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="add-field">
              <label className="add-label">Amount (₹)</label>
              <input className="add-input" type="number" inputMode="decimal" placeholder="0.00"
                value={entryForm.amount} onChange={e => setEntryForm(f => ({ ...f, amount: e.target.value }))} autoFocus />
            </div>

            <div className="add-field">
              <label className="add-label">Type</label>
              <div className="type-toggle">
                <button className={`type-btn${entryForm.type === 'gave' ? ' active debit' : ''}`}
                  onClick={() => setEntryForm(f => ({ ...f, type: 'gave' }))}>You Gave</button>
                <button className={`type-btn${entryForm.type === 'got' ? ' active credit' : ''}`}
                  onClick={() => setEntryForm(f => ({ ...f, type: 'got' }))}>You Got</button>
              </div>
            </div>

            <div className="add-field">
              <label className="add-label">Note (optional)</label>
              <input className="add-input" type="text" placeholder="e.g. Lunch money"
                value={entryForm.note} onChange={e => setEntryForm(f => ({ ...f, note: e.target.value }))} />
            </div>

            <div className="add-field">
              <label className="add-label">Date</label>
              <input className="add-input" type="date"
                value={entryForm.date || istDateKey(Date.now())}
                onChange={e => setEntryForm(f => ({ ...f, date: e.target.value }))} />
            </div>

            <button className="add-txn-submit" onClick={submitEntry} disabled={!entryForm.amount || parseFloat(entryForm.amount) <= 0}>
              {entrySheetMode === 'edit' ? 'Save Changes' : 'Add Entry'}
            </button>
            {entrySheetMode === 'edit' && (
              <button className="add-txn-delete" onClick={() => deleteEntry(entryForm.id)}>
                Delete Entry
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
