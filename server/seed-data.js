// Seed dummy data for local development testing
// Only runs when DEV_AUTH_BYPASS=true and database is empty

const store = require('./store')

function seedData(userId) {
  console.log(`🌱 Seeding test data for user: ${userId}`)

  const now = Date.now()
  const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000
  const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000
  const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000
  const yesterday = now - 24 * 60 * 60 * 1000
  const today = now
  const tomorrow = now + 24 * 60 * 60 * 1000

  // ── Khatabook: Contacts & Entries ──
  const contacts = [
    { id: 'contact-1', name: 'Ahmed Khan', phone: '+92-300-1234567', notes: 'Close friend' },
    { id: 'contact-2', name: 'Fatima Ali', phone: '+92-301-2345678', notes: 'Sister' },
    { id: 'contact-3', name: 'Hassan Raza', phone: '+92-302-3456789', notes: 'Colleague' },
    { id: 'contact-4', name: 'Zara Malik', phone: '+92-303-4567890', notes: 'Neighbor' },
  ]

  const entries = [
    {
      id: 'entry-1',
      contactId: 'contact-1',
      type: 'gave',
      amount: 500,
      description: 'Lunch money',
      date: yesterday,
    },
    {
      id: 'entry-2',
      contactId: 'contact-1',
      type: 'got',
      amount: 300,
      description: 'Returned book',
      date: yesterday,
    },
    {
      id: 'entry-3',
      contactId: 'contact-2',
      type: 'gave',
      amount: 2000,
      description: 'Eid gift',
      date: twoDaysAgo,
    },
    {
      id: 'entry-4',
      contactId: 'contact-3',
      type: 'gave',
      amount: 1500,
      description: 'Coffee & snacks',
      date: oneWeekAgo,
    },
    {
      id: 'entry-5',
      contactId: 'contact-3',
      type: 'got',
      amount: 1500,
      description: 'Paid back',
      date: oneWeekAgo + 3 * 24 * 60 * 60 * 1000,
    },
    {
      id: 'entry-6',
      contactId: 'contact-4',
      type: 'gave',
      amount: 750,
      description: 'Borrowed sugar & flour',
      date: oneMonthAgo,
    },
  ]

  // Store Khatabook data
  contacts.forEach((c) => {
    store.appendItem(store.TABLES.LEDGER_CONTACTS, userId, c)
  })
  entries.forEach((e) => {
    store.appendItem(store.TABLES.LEDGER_ENTRIES, userId, e)
  })

  // ── Milestones: Milestones, Goals & Tasks ──
  const milestones = [
    {
      id: 'milestone-1',
      title: 'Ramadan 2025',
      description: 'Complete Quran & daily prayers',
      startDate: oneWeekAgo,
      durationDays: 30,
      archived: false,
    },
    {
      id: 'milestone-2',
      title: 'Fitness Challenge',
      description: 'Build a consistent workout habit',
      startDate: now,
      durationDays: 60,
      archived: false,
    },
  ]

  const goals = [
    {
      id: 'goal-1',
      title: 'Complete Quran',
      description: 'Read Quran daily for 30 days',
      milestoneId: 'milestone-1',
      startDate: oneWeekAgo,
      durationDays: 30,
      archived: false,
    },
    {
      id: 'goal-2',
      title: 'Morning Prayers',
      description: 'Never miss Fajr & Dhuhr',
      milestoneId: 'milestone-1',
      startDate: oneWeekAgo,
      durationDays: 30,
      archived: false,
    },
    {
      id: 'goal-3',
      title: 'Exercise 5x/week',
      description: 'Gym or running',
      milestoneId: 'milestone-2',
      startDate: now,
      durationDays: 60,
      archived: false,
    },
    {
      id: 'goal-4',
      title: 'Learn Arabic',
      description: 'Study 30 mins daily',
      startDate: oneMonthAgo,
      durationDays: 90,
      archived: false,
    },
  ]

  const tasks = [
    // Complete Quran tasks
    { id: 'task-1', goalId: 'goal-1', title: 'Quran Day 1', date: oneWeekAgo, completed: true },
    { id: 'task-2', goalId: 'goal-1', title: 'Quran Day 2', date: oneWeekAgo + 1 * 24 * 60 * 60 * 1000, completed: true },
    { id: 'task-3', goalId: 'goal-1', title: 'Quran Day 3', date: oneWeekAgo + 2 * 24 * 60 * 60 * 1000, completed: true },
    { id: 'task-4', goalId: 'goal-1', title: 'Quran Day 4', date: yesterday, completed: true },
    { id: 'task-5', goalId: 'goal-1', title: 'Quran Day 5', date: today, completed: true },
    { id: 'task-6', goalId: 'goal-1', title: 'Quran Day 6', date: tomorrow, completed: false },

    // Morning Prayers tasks
    { id: 'task-7', goalId: 'goal-2', title: 'Fajr Prayer', date: yesterday, completed: true },
    { id: 'task-8', goalId: 'goal-2', title: 'Dhuhr Prayer', date: yesterday, completed: true },
    { id: 'task-9', goalId: 'goal-2', title: 'Fajr Prayer', date: today, completed: true },
    { id: 'task-10', goalId: 'goal-2', title: 'Dhuhr Prayer', date: today, completed: false },

    // Exercise tasks
    { id: 'task-11', goalId: 'goal-3', title: 'Gym Session', date: today, completed: true },
    { id: 'task-12', goalId: 'goal-3', title: 'Run 5km', date: tomorrow, completed: false },

    // Learn Arabic tasks
    { id: 'task-13', goalId: 'goal-4', title: 'Study Alphabet', date: oneMonthAgo, completed: true },
    { id: 'task-14', goalId: 'goal-4', title: 'Practice Numbers', date: yesterday, completed: true },
    { id: 'task-15', goalId: 'goal-4', title: 'Common Phrases', date: today, completed: false },
  ]

  // Store Milestones data
  milestones.forEach((m) => {
    store.appendItem(store.TABLES.MILESTONE_MILESTONES, userId, m)
  })
  goals.forEach((g) => {
    store.appendItem(store.TABLES.MILESTONE_GOALS, userId, g)
  })
  tasks.forEach((t) => {
    store.appendItem(store.TABLES.MILESTONE_TASKS, userId, t)
  })

  // ── Health Tracker: Episodes ──
  const healthEpisodes = [
    {
      id: 'health-1',
      title: 'Flu',
      symptoms: ['Fever', 'Body ache', 'Cough'],
      treatments: [
        { name: 'Paracetamol', dosage: '500mg twice a day', notes: '' },
        { name: 'Rest & fluids', dosage: '', notes: 'Plenty of water and soup' },
      ],
      severity: 'moderate',
      doctorVisited: true,
      doctorNotes: 'Seasonal flu, prescribed rest and paracetamol.',
      startDate: oneWeekAgo,
      recoveryDate: twoDaysAgo,
      notes: 'Caught it from a coworker.',
    },
    {
      id: 'health-2',
      title: 'Cold',
      symptoms: ['Runny nose', 'Sore throat'],
      treatments: [{ name: 'Steam inhalation', dosage: '', notes: 'Twice daily' }],
      severity: 'mild',
      doctorVisited: false,
      doctorNotes: '',
      startDate: yesterday,
      recoveryDate: null,
      notes: 'Still recovering.',
    },
    {
      id: 'health-3',
      title: 'Stomach ache',
      symptoms: ['Nausea', 'Cramping'],
      treatments: [{ name: 'Antacid', dosage: '1 tablet after meals', notes: '' }],
      severity: 'mild',
      doctorVisited: false,
      doctorNotes: '',
      startDate: oneMonthAgo,
      recoveryDate: oneMonthAgo + 2 * 24 * 60 * 60 * 1000,
      notes: 'Likely something eaten outside.',
    },
  ]

  healthEpisodes.forEach((e) => {
    store.appendItem(store.TABLES.HEALTH_EPISODES, userId, e)
  })

  // ── Health Tracker: Reminders ──
  const healthReminders = [
    {
      id: 'reminder-1',
      title: 'Multivitamin refill',
      dueDate: now + 5 * 24 * 60 * 60 * 1000,
      repeatDays: 30,
      notes: 'Pharmacy on Main Street',
      completed: false,
    },
    {
      id: 'reminder-2',
      title: 'Annual checkup',
      dueDate: oneMonthAgo + 60 * 24 * 60 * 60 * 1000,
      repeatDays: null,
      notes: '',
      completed: false,
    },
  ]

  healthReminders.forEach((r) => {
    store.appendItem(store.TABLES.HEALTH_REMINDERS, userId, r)
  })

  // ── Journal: Daily check-ins ──
  const journalEntries = [
    {
      id: 'journal-1',
      date: today,
      mood: 'good',
      energy: 4,
      sleepHours: 7,
      tags: ['Work', 'Health'],
      notes: 'Solid day, finished the report and went for a walk in the evening.',
      createdAt: today,
    },
    {
      id: 'journal-2',
      date: yesterday,
      mood: 'okay',
      energy: 3,
      sleepHours: 6,
      tags: ['Work', 'Money'],
      notes: 'Busy sorting out bills, a bit tired by the evening.',
      createdAt: yesterday,
    },
    {
      id: 'journal-3',
      date: twoDaysAgo,
      mood: 'great',
      energy: 5,
      sleepHours: 8,
      tags: ['Family', 'Deen', 'Rest'],
      notes: 'Great family time after Jummah, felt very relaxed.',
      createdAt: twoDaysAgo,
    },
  ]

  journalEntries.forEach((e) => {
    store.appendItem(store.TABLES.JOURNAL_ENTRIES, userId, e)
  })

  // ── Finance: Transactions ──
  // `type: 'debit'|'credit'` (not `kind: 'expense'|'income'`) and `merchant` (not just
  // `description`) are the real fields TransactionPanel.jsx/Dashboard.jsx read everywhere —
  // matching that schema so seeded accounts behave like real ones for Finance stats/charts.
  const transactions = [
    { id: 'txn-1', category: 'food', type: 'debit', amount: 350, merchant: 'Lunch', description: 'Lunch', date: today, tags: ['daily'] },
    { id: 'txn-2', category: 'transport', type: 'debit', amount: 500, merchant: 'Uber to office', description: 'Uber to office', date: today, tags: [] },
    { id: 'txn-3', category: 'salary', type: 'credit', amount: 50000, merchant: 'Monthly salary', description: 'Monthly salary', date: yesterday, tags: ['monthly'] },
    { id: 'txn-4', category: 'utilities', type: 'debit', amount: 2500, merchant: 'Electricity bill', description: 'Electricity bill', date: twoDaysAgo, tags: ['bills'] },
    { id: 'txn-5', category: 'food', type: 'debit', amount: 1200, merchant: 'Dinner with family', description: 'Dinner with family', date: twoDaysAgo, tags: ['social'] },
    { id: 'txn-6', category: 'entertainment', type: 'debit', amount: 800, merchant: 'Movie tickets', description: 'Movie tickets', date: oneWeekAgo, tags: ['entertainment'] },
    { id: 'txn-7', category: 'shopping', type: 'debit', amount: 3500, merchant: 'Clothes shopping', description: 'Clothes shopping', date: oneWeekAgo, tags: [] },
    { id: 'txn-8', category: 'savings', type: 'credit', amount: 5000, merchant: 'Transfer to savings', description: 'Transfer to savings', date: oneWeekAgo, tags: ['savings'] },
    { id: 'txn-9', category: 'health', type: 'debit', amount: 1500, merchant: 'Doctor consultation', description: 'Doctor consultation', date: oneMonthAgo, tags: ['medical'] },
    { id: 'txn-10', category: 'freelance', type: 'credit', amount: 8000, merchant: 'Project payment', description: 'Project payment', date: oneMonthAgo, tags: [] },
  ]

  transactions.forEach((t) => {
    store.appendItem(store.TABLES.TRANSACTIONS, userId, t)
  })

  console.log(`✅ Seeded ${contacts.length} contacts, ${entries.length} entries`)
  console.log(`✅ Seeded ${milestones.length} milestones, ${goals.length} goals, ${tasks.length} tasks`)
  console.log(`✅ Seeded ${healthEpisodes.length} health episodes, ${healthReminders.length} reminders`)
  console.log(`✅ Seeded ${journalEntries.length} journal entries`)
  console.log(`✅ Seeded ${transactions.length} transactions`)
}

function isEmptyDatabase(userId) {
  try {
    const contactCount = store.db.prepare(
      `SELECT COUNT(*) as count FROM ledger_contacts WHERE owner_user_id = ?`
    ).get(userId)
    return contactCount.count === 0
  } catch {
    return true
  }
}

function initSeedData(userId) {
  if (process.env.DEV_AUTH_BYPASS === 'true' && isEmptyDatabase(userId)) {
    seedData(userId)
  }
}

module.exports = { initSeedData, seedData }
