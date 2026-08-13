/**
 * The Misal desktop component library.
 *
 * Built against the approved design in `docs/design/mockups/final-consolidated.html` and specified
 * in `docs/specs/2026-08-12-desktop-ui.md`. Two deviations from the mockup are deliberate and
 * approved: D1 (the seven identical `DRV` stamps in the readout are replaced by one panel-level
 * statement) and D2 (the stamp key is a help affordance rather than permanent chrome).
 *
 * Import `@ui/base.css` once at the application root; every component imports its own stylesheet.
 */

export * from './format'
export * from './figure'
export * from './metrics'
export * from './measured/Metric'
export * from './provenance/SourceStamp'
export * from './provenance/StampKey'
export * from './readout/CoverageMeter'
export * from './readout/ReadoutCell'
export * from './table/DataTable'
export * from './charts/HatchPattern'
export * from './charts/scale'
export * from './charts/CalibrationBar'
export * from './charts/ConcentrationChart'
export * from './charts/NetWorthStackChart'
export * from './charts/NavHistoryChart'
export { Gallery } from './gallery/Gallery'
