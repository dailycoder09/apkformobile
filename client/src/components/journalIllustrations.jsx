// Hand-drawn card illustrations, ported directly from the shared "Mirello" reference
// mockup's own SVG markup (same paths/shapes) so the Hub screen matches it exactly
// rather than being redrawn from scratch.

export function JournalIllustration({ className = 'w-36 h-32' }) {
  return (
    <svg className={className} fill="none" stroke="#22262d" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 160 140">
      <path d="M110 32a9 9 0 0 1 15-4 8 8 0 0 1 12 5 9 9 0 0 1-2 15h-25a8 8 0 0 1 0-16z" fill="#ffffff" fillOpacity="0.8" />
      <path d="M96 24a6 6 0 1 0 10 0c0-3-2-5-5-5s-5 2-5 5z" strokeWidth="1.6" />
      <path d="M99 29h4m-3 2h2" strokeWidth="1.5" />
      <path d="M93 18l-3-3m15 0l3-3m-9-4v-4" strokeWidth="1.4" />
      <path d="M91 48c0-8-5-14-13-14s-13 6-13 14c0 7 4 12 11 13v6" />
      <path d="M72 45c-4 5-8 15-8 26s8 18 10 24" fill="#22262d" fillOpacity="0.12" />
      <path d="M72 38a14 14 0 0 1 20 0" strokeWidth="2.4" />
      <rect fill="#22262d" height="11" rx="3.5" width="7" x="87" y="44" />
      <path d="M86 48a1 1 0 1 1-2 0 1 1 0 0 1 2 0m-2 6c2 1 5 0 5-1" strokeWidth="1.4" />
      <path d="M69 77l15 36h14l10-25" />
      <path d="M98 88l30 25" />
      <polygon fill="#22262d" points="102,96 126,96 117,126 93,126" />
      <line strokeWidth="2.2" x1="80" x2="148" y1="126" y2="126" />
      <path d="M78 67c3 4 8 7 13 7 5 0 9-3 12-7" />
      <path d="M78 67l-9 40m34-40l10 32" />
    </svg>
  )
}

export function QuickNotesIllustration({ className = 'w-44 h-36' }) {
  return (
    <svg className={className} fill="none" stroke="#22262d" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 180 150">
      <g transform="rotate(-6 55 85)">
        <rect fill="#ffffff" height="74" rx="4" strokeWidth="2" width="46" x="24" y="24" />
        <rect height="8" rx="1.5" width="8" x="30" y="34" />
        <line strokeWidth="2" x1="43" x2="63" y1="38" y2="38" />
        <rect height="8" rx="1.5" width="8" x="30" y="48" />
        <line strokeWidth="2" x1="43" x2="63" y1="52" y2="52" />
        <rect fill="#22262d" height="8" rx="1.5" width="8" x="30" y="62" />
        <line strokeWidth="2" x1="43" x2="57" y1="66" y2="66" />
        <rect fill="#ebebeb" height="12" rx="3" strokeWidth="1.4" width="28" x="32" y="78" />
        <text fill="#22262d" fontFamily="sans-serif" fontSize="8" fontWeight="bold" stroke="none" x="39" y="87">OK</text>
      </g>
      <path d="M125 50c-3-6 4-10 1-13-4-3-8 1-10-3s-6-1-8 3c-3 5 1 10 3 13" fill="#22262d" />
      <circle cx="120" cy="52" fill="#f5f7f9" r="10" />
      <path d="M117 50h1m5 0h1m-5 5a4 4 0 0 0 6 0" strokeWidth="1.4" />
      <path d="M114 62l-8 16 12 6" />
      <path d="M127 62l12 10-10 14" />
      <g transform="rotate(-34 115 88)">
        <polygon fill="#22262d" points="65,84 75,80 75,88" />
        <rect fill="#fcfcfc" height="10" rx="1" width="58" x="75" y="79" />
        <line x1="88" x2="88" y1="79" y2="89" />
      </g>
      <path d="M115 84l-4 34h-6m17-34l12 28 8 6" fill="none" strokeWidth="2.2" />
    </svg>
  )
}

export function QuestionnairesIllustration({ className = 'w-38 h-32' }) {
  return (
    <svg className={className} fill="none" stroke="#22262d" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 150 130">
      <path d="M42 66c-5-9 1-20 15-18 12 1 16 11 11 20-5 8-11 10-11 19" strokeWidth="4.5" />
      <circle cx="57" cy="98" fill="#22262d" r="3" />
      <circle cx="49" cy="56" fill="#22262d" r="2.5" />
      <circle cx="61" cy="57" fill="#22262d" r="2.5" />
      <path d="M45 52a3 3 0 0 1 5-2m6 1a3 3 0 0 1 5 1" strokeWidth="1.3" />
      <path d="M96 38c-12 0-18 8-16 18 1 7 8 13 8 18h16c0-5 7-11 8-18 2-10-4-18-16-18z" fill="#fffef7" strokeWidth="1.8" />
      <path d="M92 74h8m-7 4h6m-5 4h4" strokeWidth="2" />
      <circle cx="91" cy="50" fill="#22262d" r="2" />
      <circle cx="102" cy="50" fill="#22262d" r="2" />
      <path d="M89 45l3 2m8-2l3 2" strokeWidth="1.3" />
      <path d="M93 57c0 3 4 5 7 3s1-5-7-3z" fill="#22262d" />
      <line strokeWidth="1.6" x1="96" x2="96" y1="28" y2="22" />
      <line strokeWidth="1.6" x1="80" x2="74" y1="34" y2="30" />
      <line strokeWidth="1.6" x1="113" x2="119" y1="33" y2="29" />
      <rect fill="#22262d" height="42" rx="5" transform="rotate(12 118 72)" width="18" x="118" y="72" />
      <circle cx="128" cy="84" fill="#ffffff" r="1.8" />
      <circle cx="132" cy="85" fill="#ffffff" r="1.8" />
    </svg>
  )
}

export function InsightsIllustration({ className = 'w-40 h-32' }) {
  return (
    <svg className={className} fill="none" stroke="#22262d" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 160 130">
      <rect x="18" y="20" width="112" height="86" rx="8" fill="#ffffff" fillOpacity="0.55" strokeWidth="2" />
      <rect fill="#22262d" height="24" rx="2.5" width="12" x="36" y="70" />
      <rect fill="#22262d" fillOpacity="0.35" height="40" rx="2.5" width="12" x="58" y="54" />
      <rect fill="#22262d" height="56" rx="2.5" width="12" x="80" y="38" />
      <rect fill="#22262d" fillOpacity="0.35" height="30" rx="2.5" width="12" x="102" y="64" />
      <path d="M34 46l16-12 14 8 18-16" strokeWidth="2.4" />
      <polygon fill="#22262d" points="80,16 87,20 80,24" />
      <circle cx="118" cy="92" r="13" fill="#fffef7" strokeWidth="2" />
      <path d="M127 101l7 7" strokeWidth="3" />
      <path d="M111 92c0-2 2-4 4-4m-4 4c0 2 2 4 4 4" strokeWidth="1.4" />
    </svg>
  )
}

export function GoalSettingIllustration({ className = 'w-44 h-36' }) {
  return (
    <svg className={className} fill="none" stroke="#22262d" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 170 140">
      <circle cx="137" cy="46" fill="#ffffff" fillOpacity="0.5" r="16" strokeWidth="2.2" />
      <line strokeWidth="3" x1="137" x2="135" y1="62" y2="78" />
      <path d="M110 38c0-8-5-14-12-14s-12 6-12 14c0 7 4 12 10 13v5" />
      <rect height="5" rx="1.5" width="6" x="91" y="38" />
      <rect height="5" rx="1.5" width="6" x="99" y="38" />
      <line x1="97" x2="99" y1="40" y2="40" />
      <path d="M85 36c-2 6-4 22 2 34 2 4 4 14 4 18" fill="#22262d" fillOpacity="0.2" />
      <path d="M96 57l-18 20v28h44v-28l-16-20" fill="#a8c1b3" fillOpacity="0.45" />
      <path d="M96 57v26m-6-26l7 14 7-14" />
      <g transform="translate(68, 80)">
        <path d="M4 18L18 8" strokeDasharray="2 2" strokeWidth="1.4" />
        <polygon fill="#22262d" points="17,6 20,9 15,10" />
        <rect fill="#22262d" height="8" rx="0.5" width="3" x="2" y="16" />
        <rect fill="#22262d" height="12" rx="0.5" width="3" x="7" y="12" />
        <rect fill="#22262d" height="16" rx="0.5" width="3" x="12" y="8" />
      </g>
      <circle cx="94" cy="74" r="5" strokeWidth="1.3" />
      <path d="M94 74v-5m0 5l4 3" strokeWidth="1.2" />
      <rect fill="#22262d" height="13" rx="1" width="16" x="62" y="112" />
      <polygon fill="#22262d" points="62,125 78,125 84,129 60,129" />
      <rect fill="#fff" height="6" rx="1" width="26" x="114" y="114" />
      <rect fill="#22262d" height="7" rx="1" width="29" x="112" y="120" />
    </svg>
  )
}

export function HealthEpisodesIllustration({ className = 'w-40 h-32' }) {
  return (
    <svg className={className} fill="none" stroke="#22262d" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 160 130">
      <circle cx="98" cy="52" fill="#ffffff" fillOpacity="0.55" r="34" strokeWidth="2" />
      <path d="M98 34v36m-18-18h36" fill="#22262d" strokeWidth="6" />
      <path d="M40 24l-4 60c-1 10 7 18 17 18s18-8 17-18l-4-60" fill="#fffef7" strokeWidth="1.8" />
      <rect fill="#22262d" height="14" rx="2.5" width="26" x="40" y="18" />
      <circle cx="53" cy="88" fill="#c94f4f" fillOpacity="0.75" r="9" strokeWidth="1.4" />
      <line strokeWidth="1.6" x1="46" x2="46" y1="44" y2="44" />
      <line strokeWidth="1.6" x1="42" x2="50" y1="44" y2="44" />
      <line strokeWidth="1.6" x1="42" x2="50" y1="56" y2="56" />
      <line strokeWidth="1.6" x1="42" x2="50" y1="68" y2="68" />
      <path d="M108 84c-14 0-22 10-20 22 2 9 10 15 10 20h20c0-5 8-11 10-20 2-12-6-22-20-22z" fill="#e6e3d8" fillOpacity="0.4" strokeWidth="1.6" />
      <path d="M104 118h8m-6 4h4" strokeWidth="1.6" />
      <path d="M18 100c8-6 16-6 22 0m38-8c6-7 14-7 20 0" strokeWidth="1.6" />
    </svg>
  )
}

export function HealthRemindersIllustration({ className = 'w-40 h-32' }) {
  return (
    <svg className={className} fill="none" stroke="#22262d" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 160 130">
      <path d="M52 66a26 26 0 0 1 52 0v18l7 10H45l7-10z" fill="#fffef7" strokeWidth="2" />
      <path d="M70 96a8 8 0 0 0 16 0" strokeWidth="2" />
      <path d="M78 34v-8" strokeWidth="2" />
      <circle cx="78" cy="22" fill="#22262d" r="4" />
      <path d="M40 44c-6 4-10 10-11 18" strokeWidth="1.5" />
      <path d="M116 44c6 4 10 10 11 18" strokeWidth="1.5" />
      <g transform="rotate(18 128 88)">
        <rect fill="#ffffff" height="40" rx="10" strokeWidth="2" width="24" x="116" y="70" />
        <line strokeWidth="2" x1="116" x2="140" y1="90" y2="90" />
        <rect fill="#22262d" height="8" rx="2" width="14" x="121" y="63" />
        <circle cx="122" cy="80" fill="#22262d" fillOpacity="0.5" r="2.5" />
        <circle cx="134" cy="80" fill="#22262d" fillOpacity="0.5" r="2.5" />
        <circle cx="122" cy="100" fill="#22262d" fillOpacity="0.5" r="2.5" />
        <circle cx="134" cy="100" fill="#22262d" fillOpacity="0.5" r="2.5" />
      </g>
      <path d="M18 60l8 8m-8 0l8-8" strokeWidth="2.2" />
      <path d="M22 80h10" strokeWidth="2" />
    </svg>
  )
}
