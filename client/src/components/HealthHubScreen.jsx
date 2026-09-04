import { useState } from 'react'
import {
  HealthEpisodesIllustration,
  HealthRemindersIllustration,
  InsightsIllustration,
} from './journalIllustrations'
import HealthEpisodesListScreen from './HealthEpisodesListScreen'
import HealthRemindersListScreen from './HealthRemindersListScreen'
import HealthInsightsScreen from './HealthInsightsScreen'

// Hub landing screen for the Health module — mirrors JournalPanel's hub pattern
// exactly (card list of pastel panels with hand-drawn illustrations) so the two
// modules feel like siblings, just with Health-specific content and colors.
const CARDS = [
  { id: 'episodes', title: 'Episodes', lastEdited: 'Illnesses & recoveries', bg: '#e0f3ec', Illustration: HealthEpisodesIllustration, hasScreen: true },
  { id: 'reminders', title: 'Reminders', lastEdited: 'Medicine & appointments', bg: '#fdeee0', Illustration: HealthRemindersIllustration, hasScreen: true },
  { id: 'insights', title: 'Insights', lastEdited: 'Trends & recovery stats', bg: '#e6e3f5', Illustration: InsightsIllustration, hasScreen: true },
]

function BackArrow() {
  return (
    <svg className="h-6 w-6 stroke-[2.2] stroke-current" fill="none" viewBox="0 0 24 24">
      <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Card({ title, lastEdited, bg, Illustration, hasScreen, onOpen, index = 0 }) {
  return (
    <article
      onClick={hasScreen ? onOpen : undefined}
      className={`relative flex min-h-[142px] justify-between overflow-hidden rounded-3xl p-5 shadow-[0_2px_10px_rgba(0,0,0,0.03)] transition-transform ${hasScreen ? 'cursor-pointer active:scale-[0.985]' : 'opacity-90'}`}
      style={{ background: bg }}
    >
      {/* max-w keeps longer subtitles ("Medicine & appointments") from running under the
          illustration's absolutely-positioned zone — that zone is out of normal flex flow,
          so text here would otherwise wrap based on the card's full width, not the space
          actually left after the illustration. */}
      <div className="z-10 flex max-w-[58%] flex-col justify-start pt-1">
        <h3 className="text-xl font-bold tracking-tight text-slate-900">{title}</h3>
        <p className="mt-1 text-[13px] font-medium text-slate-500">{lastEdited}</p>
      </div>
      <div
        className="hub-illustration-float pointer-events-none absolute bottom-0 right-0 flex h-full w-44 items-end justify-end pb-1 pr-3"
        style={{ animationDelay: `${index * 0.35}s` }}
      >
        <Illustration />
      </div>
    </article>
  )
}

export default function HealthHubScreen({ onHome }) {
  const [screen, setScreen] = useState('hub') // 'hub' | 'episodes' | 'reminders' | 'insights'

  if (screen === 'episodes') {
    return <HealthEpisodesListScreen onBack={() => setScreen('hub')} />
  }
  if (screen === 'reminders') {
    return <HealthRemindersListScreen onBack={() => setScreen('hub')} />
  }
  if (screen === 'insights') {
    return <HealthInsightsScreen onBack={() => setScreen('hub')} />
  }

  return (
    <div className="journal-screen surface-sand flex-1 min-h-0 overflow-y-auto flex flex-col font-sans text-slate-800">
      <div className="flex shrink-0 items-center justify-between px-4 py-3">
        <button type="button" onClick={onHome} aria-label="Home" className="grid size-9 place-items-center text-slate-800">
          <BackArrow />
        </button>
        <h1 className="text-lg font-bold text-slate-900">Health</h1>
        <div className="w-9" />
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-6">
        <div className="flex flex-col gap-4">
          {CARDS.map((c, i) => (
            <Card key={c.id} {...c} index={i} onOpen={() => setScreen(c.id)} />
          ))}
        </div>
      </div>
    </div>
  )
}
