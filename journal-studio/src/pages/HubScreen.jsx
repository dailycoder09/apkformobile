import PhoneFrame from '../components/PhoneFrame'
import StatusBar from '../components/StatusBar'
import {
  JournalIllustration,
  QuickNotesIllustration,
  QuestionnairesIllustration,
  GoalSettingIllustration,
} from '../components/illustrations'

const CARDS = [
  { key: 'journal', title: 'Journal', lastEdited: 'Last edited: 7 Nov, 24', bg: 'bg-app-lavender', Illustration: JournalIllustration },
  { key: 'notes', title: 'Quick Notes', lastEdited: 'Last edited: 13 Nov, 24', bg: 'bg-app-blue-pastel', Illustration: QuickNotesIllustration },
  { key: 'quiz', title: 'Questionnaries', lastEdited: 'Last edited: 18 Dec, 24', bg: 'bg-app-butter-pastel', Illustration: QuestionnairesIllustration },
  { key: 'goals', title: 'Goal-setting', lastEdited: 'Last edited: 21 Dec, 24', bg: 'bg-app-sage-pastel', Illustration: GoalSettingIllustration },
]

function ProfileIcon() {
  return (
    <svg className="h-6 w-6 stroke-[1.8] stroke-current text-slate-800" fill="none" viewBox="0 0 24 24">
      <path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Card({ title, lastEdited, bg, Illustration, onOpen }) {
  return (
    <article
      onClick={onOpen}
      className={`group relative flex min-h-[142px] cursor-pointer justify-between overflow-hidden rounded-3xl p-5 shadow-[0_2px_10px_rgba(0,0,0,0.03)] transition-transform active:scale-[0.985] ${bg}`}
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

export default function HubScreen({ onOpenJournal }) {
  return (
    <PhoneFrame>
      <StatusBar />

      <nav className="z-20 flex w-full shrink-0 items-center justify-between px-6 py-2.5">
        <div className="w-9" />
        <h1 className="font-brand-logo pt-1 text-4xl font-bold leading-none tracking-normal text-[#121417]">Mirello</h1>
        <div className="flex w-9 justify-end">
          <ProfileIcon />
        </div>
      </nav>

      <main className="no-scrollbar relative flex-1 overflow-y-auto px-6 pb-24 pt-2">
        <div className="space-y-4">
          {CARDS.map((c) => (
            <Card key={c.key} {...c} onOpen={c.key === 'journal' ? onOpenJournal : undefined} />
          ))}
        </div>
      </main>

      <footer className="absolute inset-x-6 bottom-6 z-30">
        <button
          type="button"
          className="flex w-full items-center justify-center rounded-full bg-app-dark px-6 py-4 text-[15px] font-semibold text-white shadow-[0_8px_24px_-4px_rgba(30,34,41,0.28)] transition-all hover:bg-app-dark-hover active:scale-[0.985]"
        >
          Make a Quit note
        </button>
      </footer>
    </PhoneFrame>
  )
}
