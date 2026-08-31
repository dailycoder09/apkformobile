import { formatINR, formatShortDate } from '../utils/khataFormat'

// Dedicated full-page contact detail — mobile only. Replaces the old "persistent contact
// detail glued to the bottom of the Entries page" pattern: tapping a contact in Accounts/
// History now navigates here instead of expanding an inline section, per explicit user
// request ("new page should be seen for all history of that customer instead of showing
// in bottom"). Rendered by KhatabookPanel.jsx in place of the SwipeCarousel when its
// `contactPageOpen` flag is true — this component owns no navigation state itself, just
// the back/add-entry callbacks passed down.
//
// Flat page, no boxed Tile panels — matches every other mobile treatment in this module.
// No edit/delete icons anywhere on this page: the whole header is a button that opens
// Edit Contact, and each entry row is a button that opens Edit Entry — both sheets already
// have their own "Delete Contact"/"Delete Entry" button inside, so a separate delete icon
// out here would just be a second, redundant way to do the same thing.
export default function KhatabookContactPage({ contact, balance, entries, onBack, onAddEntry, onEditEntry, onEditContact }) {
  if (!contact) return null

  return (
    <div className="flex h-full flex-col sm:hidden">
      <div className="flex items-center gap-2 border-b border-foreground/12 pb-3">
        <button
          type="button"
          aria-label="Back to accounts"
          onClick={onBack}
          className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <span className="material-symbols-outlined text-xl">arrow_back</span>
        </button>
        <button type="button" onClick={onEditContact} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[image:var(--gradient-gold)] text-sm font-bold text-white shadow-[var(--shadow-glow)]">
            {contact.name.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold text-foreground">{contact.name}</p>
            <p className={`truncate text-xs font-semibold ${balance > 0 ? 'text-success' : balance < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
              {balance === 0 ? 'Settled' : `${formatINR(Math.abs(balance))} · ${balance > 0 ? 'they owe you' : 'you owe them'}`}
            </p>
          </div>
        </button>
        <button
          type="button"
          aria-label="Add entry"
          onClick={onAddEntry}
          className="grid size-9 shrink-0 place-items-center rounded-full bg-secondary text-foreground transition-colors hover:bg-secondary/70 active:scale-95"
        >
          <span className="material-symbols-outlined text-lg">add</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pb-24">
        {entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <span className="material-symbols-outlined text-4xl text-muted-foreground">receipt_long</span>
            <p className="font-semibold text-foreground">No entries yet</p>
            <p className="text-sm text-muted-foreground">Tap Add entry to log money given or received</p>
          </div>
        ) : (
          <div className="mt-3 flex flex-col divide-y divide-foreground/12">
            {entries.map(e => (
              <button key={e.id} type="button" onClick={() => onEditEntry(e)} className="flex w-full items-center gap-2.5 py-2.5 text-left">
                <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">{e.type === 'gave' ? 'You gave' : 'You got'}</span>
                  {' · '}{formatShortDate(e.date)}{e.note ? ` · ${e.note}` : ''}
                </p>
                <span
                  className={`num shrink-0 rounded-full px-2 py-0.5 text-xs font-bold ${
                    e.type === 'gave' ? 'bg-destructive-soft text-destructive' : 'bg-success-soft text-success'
                  }`}
                >
                  {e.type === 'gave' ? '−' : '+'}{formatINR(e.amount)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
