import { useState, useEffect, useMemo } from 'react'

// Same "don't trust the browser's own timezone" pattern already used in TransactionPanel.jsx
// / AdminTransactionView.jsx — duplicated rather than shared, matching how those two files
// each keep their own copy rather than a shared util (see project conventions).
const IST_TZ = 'Asia/Kolkata'
function istDateKey(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: IST_TZ }) // YYYY-MM-DD
}
function istDateInputToMs(dateStr) {
  return new Date(`${dateStr}T00:00:00+05:30`).getTime()
}
function formatINR(n) {
  return '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function formatDate(ms) {
  return new Date(ms).toLocaleDateString('en-IN', { timeZone: IST_TZ, day: 'numeric', month: 'short', year: 'numeric' })
}

const EMPTY_CONTACT_FORM = { name: '', phone: '', note: '' }
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

  const selectedContact = contacts.find(c => c.id === selectedContactId) || null
  const selectedEntries = useMemo(
    () => entries.filter(e => e.contactId === selectedContactId).sort((a, b) => b.date - a.date),
    [entries, selectedContactId]
  )
  const selectedBalance = selectedContactId ? (balances[selectedContactId] || 0) : 0

  function openAddContact() {
    setContactForm(EMPTY_CONTACT_FORM)
    setContactSheetOpen(true)
  }

  function submitContact() {
    const name = contactForm.name.trim()
    if (!name) return
    const contact = {
      id: Math.random().toString(36).slice(2),
      name,
      phone: contactForm.phone.trim(),
      note: contactForm.note.trim(),
      createdAt: Date.now(),
    }
    setContacts(prev => [contact, ...prev])
    sendMsg({ type: 'ledger_contact_add', contact })
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
    if (!amount || amount <= 0 || !selectedContactId) return
    const dateMs = entryForm.date ? istDateInputToMs(entryForm.date) : Date.now()
    if (entrySheetMode === 'edit') {
      const updated = { id: entryForm.id, contactId: selectedContactId, type: entryForm.type, amount, note: entryForm.note.trim(), date: dateMs }
      setEntries(prev => prev.map(e => e.id === updated.id ? updated : e))
      sendMsg({ type: 'ledger_entry_update', entry: updated })
    } else {
      const entry = { id: Math.random().toString(36).slice(2), contactId: selectedContactId, type: entryForm.type, amount, note: entryForm.note.trim(), date: dateMs }
      setEntries(prev => [entry, ...prev])
      sendMsg({ type: 'ledger_entry_add', entry })
    }
    setEntrySheetMode(null)
  }

  function deleteEntry(id) {
    setEntries(prev => prev.filter(e => e.id !== id))
    sendMsg({ type: 'ledger_entry_delete', id })
    setEntrySheetMode(null)
  }

  return (
    <div className="khata-screen">
      <div className="khata-header">
        <button
          className="khata-home-btn"
          onClick={() => selectedContactId ? setSelectedContactId(null) : onHome()}
          aria-label={selectedContactId ? 'Back to contacts' : 'Home'}
        >
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <span className="khata-title">{selectedContact ? selectedContact.name : 'Khatabook'}</span>
      </div>

      <div className="khata-body">
        {!selectedContact ? (
          <>
            <div className="khata-summary-card">
              <div className="khata-summary-top">
                <span className="khata-summary-label">Overall Balance</span>
                <span className="khata-summary-sub">{contacts.length} contact{contacts.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="khata-card-divider" />
              <div className="khata-summary-stats">
                <div className="khata-summary-stat get">
                  <span className="khata-summary-stat-label">You'll Get</span>
                  <span className="khata-summary-stat-val">{formatINR(totals.youllGet)}</span>
                </div>
                <div className="khata-summary-stat pay">
                  <span className="khata-summary-stat-label">You'll Pay</span>
                  <span className="khata-summary-stat-val">{formatINR(totals.youllPay)}</span>
                </div>
              </div>
            </div>

            <div className="khata-list-card">
              {sortedContacts.length === 0 ? (
                <div className="khata-empty">
                  <span className="material-symbols-outlined khata-empty-icon">group_off</span>
                  <p>No contacts yet</p>
                  <p className="khata-empty-sub">Tap + to add someone you lend to or borrow from</p>
                </div>
              ) : sortedContacts.map(c => {
                const bal = balances[c.id] || 0
                return (
                  <div key={c.id} className="khata-contact-row" onClick={() => setSelectedContactId(c.id)}>
                    <div className="khata-contact-icon">
                      <span className="material-symbols-outlined">person</span>
                    </div>
                    <div className="khata-contact-info">
                      <span className="khata-contact-name">{c.name}</span>
                      {(c.phone || c.note) && <span className="khata-contact-sub">{[c.phone, c.note].filter(Boolean).join(' · ')}</span>}
                    </div>
                    <div className="khata-contact-right">
                      <span className={`khata-contact-balance ${bal > 0 ? 'get' : bal < 0 ? 'pay' : 'even'}`}>
                        {bal === 0 ? 'Settled' : formatINR(Math.abs(bal))}
                      </span>
                      {bal !== 0 && <span className="khata-contact-balance-tag">{bal > 0 ? 'to get' : 'to pay'}</span>}
                    </div>
                    <button
                      className="khata-row-delete"
                      onClick={(e) => { e.stopPropagation(); deleteContact(c.id) }}
                      aria-label="Delete contact"
                    >
                      <span className="material-symbols-outlined">delete</span>
                    </button>
                  </div>
                )
              })}
            </div>
          </>
        ) : (
          <>
            <div className="khata-summary-card">
              <div className="khata-summary-top">
                <span className="khata-summary-label">{selectedContact.name}</span>
                {(selectedContact.phone || selectedContact.note) && (
                  <span className="khata-summary-sub">{[selectedContact.phone, selectedContact.note].filter(Boolean).join(' · ')}</span>
                )}
              </div>
              <div className="khata-card-divider" />
              <div className="khata-contact-detail-balance">
                <span className={`khata-detail-balance-val ${selectedBalance > 0 ? 'get' : selectedBalance < 0 ? 'pay' : 'even'}`}>
                  {selectedBalance === 0 ? 'Settled up' : formatINR(Math.abs(selectedBalance))}
                </span>
                {selectedBalance !== 0 && (
                  <span className="khata-detail-balance-tag">{selectedBalance > 0 ? 'they owe you' : 'you owe them'}</span>
                )}
              </div>
            </div>

            <div className="khata-list-card">
              {selectedEntries.length === 0 ? (
                <div className="khata-empty">
                  <span className="material-symbols-outlined khata-empty-icon">receipt_long</span>
                  <p>No entries yet</p>
                  <p className="khata-empty-sub">Tap + to log money given or received</p>
                </div>
              ) : selectedEntries.map(e => (
                <div key={e.id} className="khata-entry-row" onClick={() => openEditEntry(e)}>
                  <div className={`khata-entry-icon ${e.type}`}>
                    <span className="material-symbols-outlined">{e.type === 'gave' ? 'call_made' : 'call_received'}</span>
                  </div>
                  <div className="khata-entry-info">
                    <span className="khata-entry-label">{e.type === 'gave' ? 'You gave' : 'You got'}</span>
                    {e.note && <span className="khata-entry-note">{e.note}</span>}
                    <span className="khata-entry-date">{formatDate(e.date)}</span>
                  </div>
                  <span className={`khata-entry-amount ${e.type}`}>
                    {e.type === 'gave' ? '−' : '+'}{formatINR(e.amount)}
                  </span>
                  <button
                    className="khata-row-delete"
                    onClick={(ev) => { ev.stopPropagation(); deleteEntry(e.id) }}
                    aria-label="Delete entry"
                  >
                    <span className="material-symbols-outlined">delete</span>
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <button className="khata-fab" onClick={selectedContact ? openAddEntry : openAddContact} aria-label={selectedContact ? 'Add entry' : 'Add contact'}>
        <span className="material-symbols-outlined">add</span>
      </button>

      {contactSheetOpen && (
        <div className="add-txn-overlay" onClick={e => e.target === e.currentTarget && setContactSheetOpen(false)}>
          <div className="add-txn-sheet">
            <div className="add-txn-header">
              <span>Add Contact</span>
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
              Add Contact
            </button>
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
