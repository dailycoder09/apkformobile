export default function InstallPrompt({ onInstall, onDismiss }) {
  return (
    <div className="install-prompt">
      <div className="install-info">
        <strong>Install ChatPWA</strong>
        <span>Add to home screen for the full experience</span>
      </div>
      <div className="install-actions">
        <button className="install-btn" onClick={onInstall}>Install</button>
        <button className="dismiss-btn" onClick={onDismiss}>Later</button>
      </div>
    </div>
  )
}
