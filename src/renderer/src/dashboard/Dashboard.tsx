// STUB — owned by the dashboard views agent. Keep the exported name and props.
import type { DashboardData } from '@shared/contract'

export interface DashboardProps {
  data: DashboardData
}

export function Dashboard({ data }: DashboardProps) {
  return <pre>{JSON.stringify(data.summary, null, 2)}</pre>
}
