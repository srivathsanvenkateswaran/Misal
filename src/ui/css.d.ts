/**
 * Stylesheets are side-effect imports handled by Vite. The spec's stack decision is plain CSS with
 * custom properties, one stylesheet per component — no CSS-in-JS — so the type system only needs
 * to know these modules exist.
 */
declare module '*.css'
