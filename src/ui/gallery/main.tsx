/** Dev-server entry for the gallery: `pnpm dev`, then open /src/ui/gallery/index.html. */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Gallery } from './Gallery'

const root = document.getElementById('gallery-root')
if (!root) throw new Error('Gallery root element missing')

createRoot(root).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
)
