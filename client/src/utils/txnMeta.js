// Shared transaction category/bank metadata + helpers for TransactionPanel and AdminTransactionView.
// Custom categories are also embedded directly on each transaction (categoryLabel/Icon/Color) so a
// transaction created on one device renders correctly on another without any shared local storage.

export const CATEGORIES = [
  { id: 'upi',       label: 'UPI',       icon: 'account_balance_wallet', color: '#e0345c' },
  { id: 'bank',      label: 'Bank',      icon: 'account_balance',        color: '#c9a227' },
  { id: 'food',      label: 'Food',      icon: 'restaurant',             color: '#16a34a' },
  { id: 'shopping',  label: 'Shopping',  icon: 'shopping_cart',          color: '#7c6ae8' },
  { id: 'transport', label: 'Transport', icon: 'directions_car',         color: '#0284c7' },
  { id: 'utilities', label: 'Utilities', icon: 'bolt',                   color: '#ea580c' },
  { id: 'manual',    label: 'Other',     icon: 'edit_note',              color: '#8a7175' },
]

export const TRANSFER_META = { id: 'transfer', label: 'Transfer', icon: 'swap_horiz', color: '#64748b' }

const CUSTOM_PALETTE = ['#d946a8', '#0891b2', '#65a30d', '#9333ea', '#dc2626', '#0d9488', '#ca8a04']

// Resolves display meta (icon/label/color) for any transaction, including custom
// categories and self-transfers, using only fields present on the transaction itself.
export function getCategoryMeta(txn) {
  if (txn.type === 'transfer') return TRANSFER_META
  const builtin = CATEGORIES.find(c => c.id === txn.category)
  if (builtin) return builtin
  if (txn.categoryLabel) {
    return { id: txn.category, label: txn.categoryLabel, icon: txn.categoryIcon || 'sell', color: txn.categoryColor || '#8a7175' }
  }
  return { id: 'manual', label: 'Other', icon: 'edit_note', color: '#8a7175' }
}

function storageKey(prefix, userId) {
  return `meeee_txn_${prefix}_${userId || 'default'}`
}

export function loadCustomCategories(userId) {
  try {
    return JSON.parse(localStorage.getItem(storageKey('categories', userId)) || '[]')
  } catch {
    return []
  }
}

export function addCustomCategory(userId, label) {
  const trimmed = label.trim()
  if (!trimmed) return null
  const existing = loadCustomCategories(userId)
  const dupe = existing.find(c => c.label.toLowerCase() === trimmed.toLowerCase())
  if (dupe) return dupe
  const color = CUSTOM_PALETTE[existing.length % CUSTOM_PALETTE.length]
  const cat = { id: `custom:${trimmed.toLowerCase().replace(/\s+/g, '-')}-${Math.random().toString(36).slice(2, 6)}`, label: trimmed, icon: 'sell', color }
  localStorage.setItem(storageKey('categories', userId), JSON.stringify([...existing, cat]))
  return cat
}

// Bank/account list: seeded from any bank names already observed in the user's transaction
// history (e.g. from parsed SMS), merged with any accounts the user has explicitly added.
export function loadBanks(userId, txns = []) {
  const stored = (() => {
    try { return JSON.parse(localStorage.getItem(storageKey('banks', userId)) || '[]') } catch { return [] }
  })()
  const observed = [...new Set(
    txns.filter(t => t.type !== 'transfer' && t.bank && t.bank !== 'Manual').map(t => t.bank)
  )]
  return [...new Set([...stored, ...observed])]
}

export function addBank(userId, name) {
  const trimmed = name.trim()
  if (!trimmed) return null
  const existing = (() => {
    try { return JSON.parse(localStorage.getItem(storageKey('banks', userId)) || '[]') } catch { return [] }
  })()
  if (!existing.includes(trimmed)) {
    localStorage.setItem(storageKey('banks', userId), JSON.stringify([...existing, trimmed]))
  }
  return trimmed
}
