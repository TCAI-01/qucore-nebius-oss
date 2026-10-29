import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Site-wide footer: shown under every page (landing, sign-in and the app).
function Footer() {
  return (
    <footer className="border-t border-line bg-ink px-4 py-4 text-center text-xs text-muted">
      © {new Date().getFullYear()} That AI Company. All intellectual property in QuCoRe belongs to That AI Company.
      <span className="mx-1.5" aria-hidden="true">·</span>
      Open source under the GNU AGPL-3.0.
    </footer>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><App /><Footer /></React.StrictMode>)
