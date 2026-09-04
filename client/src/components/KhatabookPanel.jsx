import { useState, useEffect, useMemo } from 'react'
import { PageShell } from './PageShell'
import { Celebrate } from './Celebrate'
import SwipeCarousel from './SwipeCarousel'
import KhatabookEntriesSection from './KhatabookEntriesSection'
import KhatabookAnalyticsSection from './KhatabookAnalyticsSection'
import KhatabookContactPage from './KhatabookContactPage'
import { formatINR, formatShortDate } from '../utils/khataFormat'
import { getCache, setCache } from '../lib/offlineCache'

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
export default function KhatabookPanel({ session, sendMsg, addListener, onHome, onProfileOpen }) {
  // Seeded from cache so something real renders even offline, before ledger_data_get's
  // reply (or lack thereof) arrives.
  const cachedLedgerData = getCache('ledger_data', session.userId)
  const [contacts, setContacts] = useState(() => cachedLedgerData?.contacts || [])
  const [entries, setEntries] = useState(() => cachedLedgerData?.entries || [])
  const [selectedContactId, setSelectedContactId] = useState(null)

  // Mobile-only navigation flag: true only when a contact row was actually tapped in the
  // Accounts/History list (see openContactPage below). Deliberately NOT derived from
  // `selectedContact` alone — that value falls back to the most-recently-created contact
  // even before the user has tapped anything, which would make the dedicated contact page
  // appear on first load instead of only on an explicit tap.
  const [contactPageOpen, setContactPageOpen] = useState(false)

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
        setCache('ledger_data', session.userId, {
          contacts: msg.contacts || [], entries: msg.entries || [],
        })
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

  // Mobile-only: tapping a contact row in Accounts/History navigates to the dedicated
  // contact-detail page (KhatabookContactPage) instead of the old inline "select + jump
  // straight into Add Entry" flow — the page itself now owns the one-tap Add Entry action.
  function openContactPage(id) {
    setSelectedContactId(id)
    setContactPageOpen(true)
  }

  function closeContactPage() {
    setContactPageOpen(false)
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
        session={session}
        sendMsg={sendMsg}
        addListener={addListener}
        showProfile
        onProfileOpen={onProfileOpen}
        action={
          <div className="tile-static hidden shrink-0 px-5 py-3 text-right sm:block">
            <p className={`num text-2xl font-extrabold ${netPosition >= 0 ? 'text-success' : 'text-destructive'}`}>
              {netPosition < 0 ? '−' : ''}{formatINR(Math.abs(netPosition))}
            </p>
            <p className="text-[11px] text-muted-foreground">net position</p>
          </div>
        }
      >
        <Celebrate show={cheer.n > 0} message={cheer.msg} key={cheer.n} />

        {/* Mobile: two swipeable pages (entries, then analytics) so the screen isn't one
            long scroll. Desktop: both sections stacked, unchanged from before the split —
            same two components either way, so there's nothing to fall out of sync.
            When contactPageOpen is true (a contact row was tapped), the dedicated
            KhatabookContactPage replaces the whole carousel here — not a third carousel
            page (confusing swipe semantics) and not an inline section stacked below it. */}
        {/* 140px = PageShell's mobile header height through BottomNav. This is a real magic
            number tied to PageShell's current mobile header height — if that header's height
            changes again, re-measure with Playwright (carouselTop/navTop getBoundingClientRect)
            rather than guessing, both directions of this number being wrong are visible bugs
            (dead gap above the nav, or the carousel overlapping/hiding behind it). Re-measured
            after CornerMenu moved from a floating fixed trigger (pt-16 header, 184px) to
            mounting inline in PageShell's header row (pt-6 header) — that migration shrank the
            header by 44px but this value was missed at the time, leaving a 44px dead gap above
            BottomNav on this page until caught during the Journal module build. */}
        <div className="md:hidden" style={{ height: 'calc(100dvh - 120px)' }}>
          {contactPageOpen && selectedContact ? (
            <KhatabookContactPage
              contact={selectedContact}
              balance={selectedBalance}
              entries={selectedEntries}
              onBack={closeContactPage}
              onAddEntry={openAddEntry}
              onEditEntry={openEditEntry}
              onEditContact={() => openEditContact(selectedContact)}
            />
          ) : (
            <SwipeCarousel hintNext="Swipe left for analytics →" hintPrev="Swipe right for entries →">
              <KhatabookEntriesSection
                totals={totals}
                positiveCount={positiveCount}
                negativeCount={negativeCount}
                contacts={contacts}
                settledCount={settledCount}
                sortedContacts={sortedContacts}
                balances={balances}
                entries={entries}
                selectedContact={selectedContact}
                setSelectedContactId={setSelectedContactId}
                selectedEntries={selectedEntries}
                selectedBalance={selectedBalance}
                openAddContact={openAddContact}
                openEditContact={openEditContact}
                deleteContact={deleteContact}
                openAddEntry={openAddEntry}
                openEditEntry={openEditEntry}
                deleteEntry={deleteEntry}
                onOpenContactPage={openContactPage}
              />
              <KhatabookAnalyticsSection
                settleScore={settleScore}
                settledCount={settledCount}
                contacts={contacts}
                entries={entries}
                totals={totals}
                pieData={pieData}
                selectedContact={selectedContact}
                selectedBalance={selectedBalance}
                balanceFlow={balanceFlow}
                topContacts={topContacts}
                sixMonthTrend={sixMonthTrend}
                badges={badges}
              />
            </SwipeCarousel>
          )}
        </div>

        {/* Floating "Add contact" — mobile only, matching Finance's txn-fab geometry
            (fixed, bottom-right, above BottomNav). Placed as a sibling of the carousel
            rather than inside it: a fixed-position element inside SwipeCarousel's
            translateX(...) container would anchor to that transformed ancestor instead
            of the viewport, per CSS's containing-block rules for transformed ancestors.
            Deliberately always "Add contact", never context-switched to "Add entry" —
            logging an entry stays a deliberate action from the contact page's own "+"
            button (openAddEntry), not something the bottom FAB switches into just
            because a contact happens to be selected. Hidden while the dedicated contact
            page is open — that's a different screen with its own "+" affordance. */}
        {!contactPageOpen && (
          <button
            type="button"
            aria-label="Add contact"
            onClick={openAddContact}
            className="fixed right-5 bottom-[90px] z-40 grid size-14 place-items-center rounded-full bg-[image:var(--gradient-gold)] text-white shadow-[var(--shadow-glow)] transition-transform active:scale-95 md:hidden"
          >
            <span className="material-symbols-outlined text-2xl">add</span>
          </button>
        )}

        <div className="hidden md:flex md:flex-col md:gap-4">
          <KhatabookEntriesSection
            totals={totals}
            positiveCount={positiveCount}
            negativeCount={negativeCount}
            contacts={contacts}
            settledCount={settledCount}
            sortedContacts={sortedContacts}
            balances={balances}
            entries={entries}
            selectedContact={selectedContact}
            setSelectedContactId={setSelectedContactId}
            selectedEntries={selectedEntries}
            selectedBalance={selectedBalance}
            openAddContact={openAddContact}
            openEditContact={openEditContact}
            deleteContact={deleteContact}
            openAddEntry={openAddEntry}
            openEditEntry={openEditEntry}
            deleteEntry={deleteEntry}
          />
          <KhatabookAnalyticsSection
            settleScore={settleScore}
            settledCount={settledCount}
            contacts={contacts}
            entries={entries}
            totals={totals}
            pieData={pieData}
            selectedContact={selectedContact}
            selectedBalance={selectedBalance}
            balanceFlow={balanceFlow}
            topContacts={topContacts}
            sixMonthTrend={sixMonthTrend}
            badges={badges}
          />
        </div>
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
              <button className="add-txn-delete" onClick={() => { deleteContact(contactForm.id); setContactSheetOpen(false); closeContactPage() }}>
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
