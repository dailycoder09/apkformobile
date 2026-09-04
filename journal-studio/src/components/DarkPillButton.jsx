export default function DarkPillButton({ children, className = '', ...props }) {
  return (
    <button
      type="button"
      className={`flex items-center justify-center rounded-full bg-app-dark px-6 py-3.5 text-[15px] font-semibold text-white shadow-[0_8px_24px_-4px_rgba(30,34,41,0.28)] transition-all hover:bg-app-dark-hover active:scale-[0.985] ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}
