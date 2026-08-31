import { Tile, TileLabel, Stat } from './PageShell'
import { formatINR, formatShortDate, formatDate } from '../utils/khataFormat'

// Page 1 of the mobile split: current totals + the accounts list + the selected contact's
// entry ledger. Pure presentational — all state/handlers live in KhatabookPanel.jsx and are
// passed down as props. Mobile and desktop are two distinct top-level branches here (rather
// than mixing `sm:` variants into shared markup): mobile renders a flat, card-free page per
// the user's request, desktop keeps the original boxed-Tile treatment untouched.
export default function KhatabookEntriesSection(props) {
  return (
    <div className="px-1">
      <MobileFlat {...props} />
      <DesktopCards {...props} />
    </div>
  )
}

// One row in the mobile Accounts/History list. `muted` renders the settled/History
// treatment: no colored balance chip, dimmed avatar and name. No edit/delete icons here —
// those now live on the dedicated KhatabookContactPage you land on after tapping a row,
// rather than cluttering every row on this list with icons for an action you take rarely.
function ContactRow({ c, bal, entries, selected, onSelect, muted = false }) {
  const contactEntries = entries.filter(e => e.contactId === c.id)
  const lastEntry = contactEntries.reduce((latest, e) => (!latest || e.date > latest.date) ? e : latest, null)

  return (
    <button type="button" onClick={onSelect} className="flex w-full items-center gap-3 py-3.5 text-left">
      <span
        className={`grid size-10 shrink-0 place-items-center rounded-full text-sm font-bold transition-shadow ${
          selected
            ? 'bg-gold-soft text-gold ring-2 ring-gold/50'
            : muted
            ? 'bg-secondary text-muted-foreground'
            : bal > 0
            ? 'bg-success-soft text-success'
            : 'bg-destructive-soft text-destructive'
        }`}
      >
        {c.name.charAt(0).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-sm font-semibold ${selected ? 'text-gold' : muted ? 'text-muted-foreground' : 'text-foreground'}`}>
          {c.name}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {lastEntry ? `${formatShortDate(lastEntry.date)} · ${contactEntries.length} ${contactEntries.length !== 1 ? 'entries' : 'entry'}` : 'No entries yet'}
        </span>
      </span>
      {muted ? (
        <span className="shrink-0 text-xs font-semibold text-muted-foreground">Settled</span>
      ) : (
        <span className={`num shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${bal > 0 ? 'bg-success-soft text-success' : 'bg-destructive-soft text-destructive'}`}>
          {formatINR(Math.abs(bal))}
        </span>
      )}
    </button>
  )
}

// ── Mobile: flat page, no card panels — sections separated by dividers/spacing only. ──
function MobileFlat({
  totals,
  contacts,
  sortedContacts,
  balances,
  entries,
  selectedContact,
  onOpenContactPage,
}) {
  const activeContacts = sortedContacts.filter(c => (balances[c.id] || 0) !== 0)
  const settledContacts = sortedContacts.filter(c => (balances[c.id] || 0) === 0)

  return (
    <div className="sm:hidden">
      {/* Totals — plain row, no card background. Dividers use foreground/opacity rather
          than the --color-border token: that token is calibrated for a card-on-page
          contrast and all but disappears laid directly over this page's sand gradient. */}
      <div className="flex items-center justify-between gap-2 border-b border-foreground/12 pb-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">You'll Get</p>
          <p className="num mt-1 truncate text-lg font-extrabold text-success">{formatINR(totals.youllGet)}</p>
        </div>
        <div className="h-9 w-px shrink-0 bg-foreground/12" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">You'll Pay</p>
          <p className="num mt-1 truncate text-lg font-extrabold text-destructive">{formatINR(totals.youllPay)}</p>
        </div>
        <div className="h-9 w-px shrink-0 bg-foreground/12" />
        <div className="shrink-0 text-right">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Contacts</p>
          <p className="num mt-1 text-lg font-extrabold text-foreground">{contacts.length}</p>
        </div>
      </div>

      {/* Accounts — active balances only. Settled contacts move to History below, so this
          list stays focused on who you actually still owe or are owed by.
          "Add contact" moved to the floating action button (KhatabookPanel.jsx), matching
          Finance's pattern, so this header doesn't need its own button. */}
      <div className="mt-4">
        <div className="flex items-center gap-1.5">
          <span className="material-symbols-outlined text-sm text-gold">group</span>
          <TileLabel>Accounts</TileLabel>
        </div>

        {sortedContacts.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <span className="material-symbols-outlined text-4xl text-muted-foreground">group_off</span>
            <p className="font-semibold text-foreground">No contacts yet</p>
            <p className="text-sm text-muted-foreground">Tap Add contact for someone you lend to or borrow from</p>
          </div>
        ) : activeContacts.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">All accounts are settled — nice and clean.</p>
        ) : (
          <div className="mt-2 flex flex-col divide-y divide-foreground/12">
            {activeContacts.map(c => (
              <ContactRow
                key={c.id}
                c={c}
                bal={balances[c.id] || 0}
                entries={entries}
                selected={c.id === selectedContact?.id}
                onSelect={() => onOpenContactPage(c.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* History — settled contacts, kept out of the active list above but still one tap
          away for reference (past entries, re-opening if a new balance starts). */}
      {settledContacts.length > 0 && (
        <div className="mt-4">
          <div className="flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm text-muted-foreground">history</span>
            <TileLabel>History</TileLabel>
          </div>
          <div className="mt-2 flex flex-col divide-y divide-foreground/12">
            {settledContacts.map(c => (
              <ContactRow
                key={c.id}
                c={c}
                bal={0}
                entries={entries}
                selected={c.id === selectedContact?.id}
                onSelect={() => onOpenContactPage(c.id)}
                muted
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Desktop: original boxed-Tile treatment, unchanged. ──
function DesktopCards({
  totals,
  positiveCount,
  negativeCount,
  contacts,
  settledCount,
  sortedContacts,
  balances,
  entries,
  selectedContact,
  setSelectedContactId,
  selectedEntries,
  selectedBalance,
  openAddContact,
  openEditContact,
  deleteContact,
  openAddEntry,
  openEditEntry,
  deleteEntry,
}) {
  return (
    <div className="hidden sm:block">
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
    </div>
  )
}
