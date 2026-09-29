import { copyText } from '../clipboard'
import { useCallback, useEffect, useState } from 'react'
import { errorText } from '../errorText'
import { apiGetDebugState, type DebugState } from '../api'

/**
 * The server's own view of itself, rendered for a human.
 *
 * Deliberately the *same* payload `GET /debug/state` hands an agent: one source
 * of truth, so what you read on screen and what a script reads over HTTP cannot
 * disagree. That also means the fastest way to automate anything you see here
 * is to call the endpoint named at the bottom of the panel.
 */
export function InspectTab() {
  const [state, setState] = useState<DebugState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(true)

  /** Manual refresh, for the button and the retry path. */
  const refresh = useCallback(async () => {
    try {
      setState(await apiGetDebugState())
      setError(null)
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  useEffect(() => {
    // `cancelled` matters as much as the timers: a response that lands after
    // this panel is unmounted would otherwise set state on a dead component.
    let cancelled = false

    const tick = async () => {
      try {
        const next = await apiGetDebugState()
        if (cancelled) return
        setState(next)
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError(errorText(err))
      }
    }

    // Deferred rather than called inline so the first read is scheduled like
    // every later one, and this effect never touches state synchronously.
    const first = setTimeout(() => void tick(), 0)
    const repeat = live ? setInterval(() => void tick(), 2000) : undefined

    return () => {
      cancelled = true
      clearTimeout(first)
      if (repeat !== undefined) clearInterval(repeat)
    }
  }, [live])

  if (error) {
    return (
      <div className="inspect-panel">
        <p className="field-error">Could not read server state: {error}</p>
        <button className="secondary" onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    )
  }

  if (!state) return <p className="tab-empty-state">Reading server state…</p>

  return (
    <div className="inspect-panel">
      <div className="inspect-toolbar">
        <label className="inspect-live">
          <input type="checkbox" checked={live} onChange={e => setLive(e.target.checked)} />
          Live
        </label>
        <button className="secondary" onClick={() => void refresh()}>
          Refresh
        </button>
        <button
          className="secondary"
          onClick={() => void copyText(JSON.stringify(state, null, 2))}
        >
          Copy JSON
        </button>
      </div>

      <section className="inspect-section">
        <h3 className="sub-heading">Server</h3>
        <dl className="inspect-grid">
          <dt>Base URL</dt>
          <dd>
            <code>{state.base_url}</code>
            {state.base_url.includes('localhost') && (
              <span className="inspect-note">
                {' '}
                — loopback. Peers on another device cannot reach this; set
                <code> BASE_URL</code> to a LAN address before pairing off-machine.
              </span>
            )}
          </dd>

          <dt>gRPC</dt>
          <dd>
            {state.grpc.enabled ? (
              <>
                listening on <code>{state.grpc.authority}</code>, relay{' '}
                {state.grpc.relay_enabled ? 'enabled' : 'disabled'}
              </>
            ) : (
              <>disabled — helpers cannot advertise a gRPC endpoint</>
            )}
          </dd>
        </dl>
      </section>

      <section className="inspect-section">
        <h3 className="sub-heading">
          Actors <span className="tab-count">{state.actors.length}</span>
        </h3>
        {state.actors.length === 0 ? (
          <p className="tab-empty-state">No actors registered yet.</p>
        ) : (
          <table className="inspect-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Transport</th>
                <th>Endpoints</th>
                <th>Instances</th>
              </tr>
            </thead>
            <tbody>
              {state.actors.map(actor => (
                <tr key={actor.id}>
                  <td>
                    {actor.name}
                    {actor.browser_managed && <span className="inspect-flag">browser</span>}
                    {actor.disabled && <span className="inspect-flag offline">offline</span>}
                  </td>
                  <td>{actor.role}</td>
                  <td>
                    <code>{actor.transport_mode}</code>
                  </td>
                  <td>
                    {actor.transports.map(t => (
                      <div key={t.uri}>
                        <code>{t.uri}</code>
                      </div>
                    ))}
                  </td>
                  <td>
                    {/* More than one means this actor mirrors another owner's
                        vault as a replica, beyond protecting its own. */}
                    {actor.instance_secret_ids.length}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="inspect-section">
        <h3 className="sub-heading">
          Channel routes <span className="tab-count">{state.routes.length}</span>
        </h3>
        <p className="inspect-hint">
          How an inbound gRPC message finds its actor — gRPC carries no actor in
          its URI, so the channel id on the envelope is the only key.{' '}
          <strong>bound</strong> means the pairing completed; <strong>pinned</strong>{' '}
          means a contact was minted and the handshake never finished.
        </p>
        {state.routes.length === 0 ? (
          <p className="tab-empty-state">No routes — nothing has paired over gRPC yet.</p>
        ) : (
          <table className="inspect-table">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Tier</th>
                <th>Actor</th>
              </tr>
            </thead>
            <tbody>
              {state.routes.map(route => (
                <tr key={`${route.channel_id}-${route.tier}`}>
                  <td>
                    <code>{route.channel_id}</code>
                  </td>
                  <td>
                    <span className={`transport-tag transport-tag--${route.tier}`}>
                      {route.tier}
                    </span>
                  </td>
                  <td>
                    <code>{route.actor_id}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="inspect-hint">
        Everything above is <code>GET {state.base_url}/debug/state</code>, verbatim.
        The event log beside it is <code>/debug/events</code>. See{' '}
        <code>AGENTS.md</code> for recipes.
        {state.events_dropped > 0 && (
          <>
            {' '}
            <strong>{state.events_dropped}</strong> event
            {state.events_dropped === 1 ? '' : 's'} have fallen out of the retained
            window.
          </>
        )}
      </p>
    </div>
  )
}
