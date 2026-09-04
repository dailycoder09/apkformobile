import * as localData from './localData'

// Maps every personal-tracking WS message type this app used to send to the server
// onto a call into localData.js (IndexedDB), synthesizing the exact same reply shape
// the server used to send back. This is the whole point of the offline refactor: the
// kept panels (Dashboard, TransactionPanel, KhatabookPanel, MilestonePanel,
// HealthTrackerPanel, NamazTracker, ProfilePage/CornerMenu) still call
// sendMsg({type:'transaction_add', ...}) and addListener for 'transaction_new' exactly
// as before — only what's underneath those two functions changed, so none of those
// files needed to change at all.
//
// Ledger/Milestone/Health panels only ever listen for their own full-shape reply
// (`ledger_data`/`milestone_data`/`health_data`) — there's no granular per-item event
// for those the way Transactions has (transaction_new/updated/deleted) — so every
// mutation for those three re-fetches and re-emits the whole shape, matching what
// those panels already expect.
export async function handleLocalMessage(msg, emit) {
  try {
    const userId = await localData.getDeviceId()

    switch (msg.type) {
      // ── Transactions ──────────────────────────────────────────────────
      case 'transactions_get': {
        const transactions = await localData.getTransactions()
        emit({ type: 'transactions_list', userId, transactions })
        break
      }
      case 'transaction_add': {
        const transaction = await localData.addTransaction(msg.transaction)
        emit({ type: 'transaction_new', fromUserId: userId, transaction })
        break
      }
      case 'transaction_update': {
        const transaction = await localData.updateTransaction(msg.transaction.id, msg.transaction)
        if (transaction) emit({ type: 'transaction_updated', fromUserId: userId, transaction })
        break
      }
      case 'transaction_delete': {
        await localData.deleteTransaction(msg.id)
        emit({ type: 'transaction_deleted', fromUserId: userId, id: msg.id })
        break
      }
      case 'transaction_delete_all': {
        await localData.deleteAllTransactions()
        emit({ type: 'transactions_cleared', userId })
        break
      }

      // ── Budgets ───────────────────────────────────────────────────────
      case 'budget_get': {
        const budgets = await localData.getBudgets()
        emit({ type: 'budgets', userId, budgets })
        break
      }
      case 'budget_set': {
        // setBudget throws on invalid input (see localData.js) — caught by the
        // try/catch below, matching the server's original silent-no-op-on-bad-input
        // behavior (there's no error-reply UI for this message anywhere downstream).
        const budgets = await localData.setBudget(msg.category, msg.monthlyLimit)
        emit({ type: 'budgets', userId, budgets })
        break
      }

      // ── Khatabook / ledger ────────────────────────────────────────────
      case 'ledger_data_get':
      case 'ledger_contact_add':
      case 'ledger_contact_update':
      case 'ledger_contact_delete':
      case 'ledger_entry_add':
      case 'ledger_entry_update':
      case 'ledger_entry_delete': {
        if (msg.type === 'ledger_contact_add') await localData.addLedgerContact(msg.contact)
        else if (msg.type === 'ledger_contact_update') await localData.updateLedgerContact(msg.contact)
        else if (msg.type === 'ledger_contact_delete') await localData.deleteLedgerContact(msg.id)
        else if (msg.type === 'ledger_entry_add') await localData.addLedgerEntry(msg.entry)
        else if (msg.type === 'ledger_entry_update') await localData.updateLedgerEntry(msg.entry)
        else if (msg.type === 'ledger_entry_delete') await localData.deleteLedgerEntry(msg.id)
        emit({ type: 'ledger_data', ...(await localData.getLedgerData()) })
        break
      }

      // ── Milestones ────────────────────────────────────────────────────
      case 'milestone_data_get':
      case 'milestone_milestone_add':
      case 'milestone_milestone_update':
      case 'milestone_milestone_delete':
      case 'milestone_goal_add':
      case 'milestone_goal_update':
      case 'milestone_goal_delete':
      case 'milestone_task_add':
      case 'milestone_task_update':
      case 'milestone_task_delete':
      case 'milestone_tasks_bulk_add': {
        if (msg.type === 'milestone_milestone_add') await localData.addMilestone(msg.milestone)
        else if (msg.type === 'milestone_milestone_update') await localData.updateMilestone(msg.milestone)
        else if (msg.type === 'milestone_milestone_delete') await localData.deleteMilestone(msg.id)
        else if (msg.type === 'milestone_goal_add') await localData.addGoal(msg.goal)
        else if (msg.type === 'milestone_goal_update') await localData.updateGoal(msg.goal)
        else if (msg.type === 'milestone_goal_delete') await localData.deleteGoal(msg.id)
        else if (msg.type === 'milestone_task_add') await localData.addTask(msg.task)
        else if (msg.type === 'milestone_task_update') await localData.updateTask(msg.task)
        else if (msg.type === 'milestone_task_delete') await localData.deleteTask(msg.id)
        else if (msg.type === 'milestone_tasks_bulk_add') await localData.addTasksBulk(msg.tasks)
        emit({ type: 'milestone_data', ...(await localData.getMilestoneData()) })
        break
      }

      // ── Health tracker ────────────────────────────────────────────────
      case 'health_data_get':
      case 'health_episode_add':
      case 'health_episode_update':
      case 'health_episode_delete':
      case 'health_reminder_add':
      case 'health_reminder_update':
      case 'health_reminder_delete': {
        if (msg.type === 'health_episode_add') await localData.addHealthEpisode(msg.episode)
        else if (msg.type === 'health_episode_update') await localData.updateHealthEpisode(msg.episode)
        else if (msg.type === 'health_episode_delete') await localData.deleteHealthEpisode(msg.id)
        else if (msg.type === 'health_reminder_add') await localData.addHealthReminder(msg.reminder)
        else if (msg.type === 'health_reminder_update') await localData.updateHealthReminder(msg.reminder)
        else if (msg.type === 'health_reminder_delete') await localData.deleteHealthReminder(msg.id)
        emit({ type: 'health_data', ...(await localData.getHealthData()) })
        break
      }

      // ── Namaz / Qada ──────────────────────────────────────────────────
      case 'namaz_data_get':
      case 'namaz_day_set':
      case 'namaz_qada_set': {
        if (msg.type === 'namaz_day_set') await localData.setNamazDay(msg.day)
        else if (msg.type === 'namaz_qada_set') await localData.setNamazQada(msg.qada)
        emit({ type: 'namaz_data', ...(await localData.getNamazData()) })
        break
      }

      // ── Profile ───────────────────────────────────────────────────────
      case 'profile_get': {
        const profile = await localData.getProfile()
        emit({ type: 'profile', userId, profile })
        break
      }
      case 'profile_update': {
        const profile = await localData.updateProfile(msg)
        emit({ type: 'profile', userId, profile })
        break
      }

      default:
        // Unrecognized/no-longer-supported message type — silently ignored, same as
        // how the server previously behaved for anything it didn't have a case for.
        break
    }
  } catch (e) {
    console.error('[localTransport] failed handling', msg.type, e)
  }
}
