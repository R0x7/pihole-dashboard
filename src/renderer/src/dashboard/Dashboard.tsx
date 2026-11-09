import { useMemo, useState } from 'react'
import type { DashboardData } from '@shared/contract'
import { ClientActivityChart } from './ClientActivityChart'
import { rankClients, rankDomains } from './helpers'
import { Panel } from './Panel'
import { QueriesChart } from './QueriesChart'
import { RankedBars } from './RankedBars'
import { BlockingStatus, SummaryTiles } from './SummaryTiles'
import './dashboard.css'

export interface DashboardProps {
  data: DashboardData
}

type ClientsMode = 'blocked' | 'total'

/**
 * Remembered outside the component so the choice also survives the dashboard
 * being unmounted and remounted (e.g. while the app shell shows an error).
 */
let rememberedClientsMode: ClientsMode = 'blocked'

const BLOCKED = 'var(--blocked, #d03b3b)'
const ACCENT = 'var(--accent, #2a78d6)'

export function Dashboard({ data }: DashboardProps) {
  const [clientsMode, setClientsModeState] = useState<ClientsMode>(rememberedClientsMode)
  const setClientsMode = (mode: ClientsMode) => {
    rememberedClientsMode = mode
    setClientsModeState(mode)
  }

  const domains = useMemo(() => rankDomains(data.topBlockedDomains), [data.topBlockedDomains])
  const clientsSource = clientsMode === 'blocked' ? data.topClientsBlocked : data.topClientsTotal
  const clients = useMemo(() => rankClients(clientsSource), [clientsSource])

  return (
    <div className="dash">
      <BlockingStatus enabled={data.summary.blockingEnabled} />
      <SummaryTiles summary={data.summary} />

      <div className="dash-grid">
        <QueriesChart history={data.history} />

        <Panel title="Top blocked domains">
          <RankedBars
            rows={domains}
            color={BLOCKED}
            unit="blocked queries"
            shareOf={data.summary.blockedQueries}
            empty="No blocked domains yet."
          />
        </Panel>

        <Panel
          title={clientsMode === 'blocked' ? 'Top clients by blocked queries' : 'Top clients by all queries'}
          actions={
            <div className="dash-toggle" role="group" aria-label="Rank clients by">
              <button
                type="button"
                aria-pressed={clientsMode === 'blocked'}
                onClick={() => setClientsMode('blocked')}
              >
                Blocked
              </button>
              <button type="button" aria-pressed={clientsMode === 'total'} onClick={() => setClientsMode('total')}>
                All queries
              </button>
            </div>
          }
        >
          <RankedBars
            rows={clients}
            color={clientsMode === 'blocked' ? BLOCKED : ACCENT}
            unit={clientsMode === 'blocked' ? 'blocked queries' : 'queries'}
            shareOf={clientsMode === 'blocked' ? data.summary.blockedQueries : data.summary.totalQueries}
            empty={clientsMode === 'blocked' ? 'No clients with blocked queries yet.' : 'No client queries yet.'}
          />
        </Panel>

        <ClientActivityChart clientHistory={data.clientHistory} />
      </div>
    </div>
  )
}
