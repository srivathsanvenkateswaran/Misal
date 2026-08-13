/**
 * The application root.
 *
 * Everything it does is wiring: the query client with the two non-default options the spec
 * requires (§2.2), the valuation instant, the startup gate, and the shell. No data flows through
 * this file.
 *
 * The valuation instant is fixed at mount rather than read on every render. A net-worth figure
 * that changes underneath a reader because the clock ticked is a figure that cannot be trusted or
 * screenshotted, and every stamp on the screen is dated against this one instant.
 *
 * `StartupGate` wraps the shell rather than sitting beside it. Every screen below it issues
 * commands that require an open database, so mounting them before the store is open would only
 * turn one explainable startup failure into a dozen unexplainable query failures.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { Shell, createQueryClient } from '../screens'
import { StartupGate } from '../screens/startup'
import './base.css'

export function App(): ReactNode {
  const [client] = useState(createQueryClient)
  const [asOf] = useState(() => new Date().toISOString())

  return (
    <QueryClientProvider client={client}>
      <StartupGate>
        <Shell asOf={asOf} />
      </StartupGate>
    </QueryClientProvider>
  )
}
