import { useState } from 'react'
import Lottie from 'lottie-react'
import {
  QuickNotesIllustration,
  QuestionnairesIllustration,
  GoalSettingIllustration,
  InsightsIllustration,
} from './journalIllustrations'
import JournalEntriesScreen from './JournalEntriesScreen'
import QuickNotesScreen from './QuickNotesScreen'
import JournalInsightsScreen from './JournalInsightsScreen'
import journalWritingAnim from '../assets/lottie/journal-writing.json'

// The Journal card's own illustration slot, now a live Lottie animation instead of
// the static hand-drawn SVG the other three cards still use — sized to match where
// that static illustration used to sit (Card's `w-44 h-full` corner slot below).
function JournalLottieIllustration() {
  return <Lottie animationData={journalWritingAnim} loop className="h-36 w-36" />
}

// Hub landing screen — ported directly from the shared "Mirello" reference (exact
// colors/illustrations, not re-skinned into the app's gold system this time, per
// explicit direction to match the screenshot as-is). Each card that has a real
// destination navigates to its own full-screen page below; cards with no built
// destination yet are inert rather than faking a broken link.
const CARDS = [
  { id: 'journal', title: 'Journal', lastEdited: 'Last edited: 7 Nov, 24', bg: '#eee3eb', Illustration: JournalLottieIllustration, hasScreen: true },
  { id: 'notes', title: 'Quick Notes', lastEdited: 'Last edited: 13 Nov, 24', bg: '#e1e9f1', Illustration: QuickNotesIllustration, hasScreen: true },
  { id: 'insights', title: 'Insights', lastEdited: 'Mood & activity trends', bg: '#fbe4ea', Illustration: InsightsIllustration, hasScreen: true },
  { id: 'quiz', title: 'Questionnaries', lastEdited: 'Last edited: 18 Dec, 24', bg: '#faecd2', Illustration: QuestionnairesIllustration, hasScreen: false },
  { id: 'goals', title: 'Goal-setting', lastEdited: 'Last edited: 21 Dec, 24', bg: '#e0ece4', Illustration: GoalSettingIllustration, hasScreen: false },
]

function BackArrow() {
  return (
    <svg className="h-6 w-6 stroke-[2.2] stroke-current" fill="none" viewBox="0 0 24 24">
      <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Card({ title, lastEdited, bg, Illustration, hasScreen, onOpen }) {
  return (
    <article
      onClick={hasScreen ? onOpen : undefined}
      className={`relative flex min-h-[142px] justify-between overflow-hidden rounded-3xl p-5 shadow-[0_2px_10px_rgba(0,0,0,0.03)] transition-transform ${hasScreen ? 'cursor-pointer active:scale-[0.985]' : 'opacity-90'}`}
      style={{ background: bg }}
    >
      <div className="z-10 flex flex-col justify-start pt-1">
        <h3 className="text-xl font-bold tracking-tight text-slate-900">{title}</h3>
        <p className="mt-1 text-[13px] font-medium text-slate-500">{lastEdited}</p>
      </div>
      <div className="pointer-events-none absolute bottom-0 right-0 flex h-full w-44 items-end justify-end pb-1 pr-3">
        <Illustration />
      </div>
    </article>
  )
}

export default function JournalPanel({ onHome }) {
  const [screen, setScreen] = useState('hub') // 'hub' | 'journal' | 'notes' | 'insights'

  if (screen === 'journal') {
    return <JournalEntriesScreen onBack={() => setScreen('hub')} />
  }
  if (screen === 'notes') {
    return <QuickNotesScreen onBack={() => setScreen('hub')} />
  }
  if (screen === 'insights') {
    return <JournalInsightsScreen onBack={() => setScreen('hub')} />
  }

  return (
    <div className="journal-screen surface-sand flex-1 min-h-0 overflow-y-auto flex flex-col font-sans text-slate-800">
      <div className="flex shrink-0 items-center justify-between px-4 py-3">
        <button type="button" onClick={onHome} aria-label="Home" className="grid size-9 place-items-center text-slate-800">
          <BackArrow />
        </button>
        <h1 className="text-lg font-bold text-slate-900">Journal</h1>
        <div className="w-9" />
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-6">
        <div className="flex flex-col gap-4">
          {CARDS.map((c) => (
            <Card key={c.id} {...c} onOpen={() => setScreen(c.id)} />
          ))}
        </div>
      </div>
    </div>
  )
}
