import { useEffect, useRef, useState } from 'react'

// A click during launch is retained until the start response supplies the job ID.
// Keep polling until the backend confirms that the worker has actually stopped.
export default function useRunStop(runningId, launching, cancel, onError) {
  const [stopping, setStopping] = useState(false)
  const requested = useRef(false)
  useEffect(() => {
    if (!runningId && !launching) {
      requested.current = false
      setStopping(false)
    }
  }, [runningId, launching])
  async function send(id) {
    try { await cancel(id) } catch (err) {
      requested.current = false
      setStopping(false)
      onError(err.message)
    }
  }
  function begin() { requested.current = false; setStopping(false) }
  async function stop() {
    requested.current = true
    setStopping(true)
    if (runningId) await send(runningId)
  }
  async function started(id) { if (requested.current) await send(id) }
  return { stopping, begin, stop, started }
}
