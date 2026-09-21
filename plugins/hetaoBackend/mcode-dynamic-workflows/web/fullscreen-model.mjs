// Canvas fullscreen mode transitions, extracted from the DOM wiring so the
// fallback order (Fullscreen API first, fixed overlay when unavailable or
// denied) and the Escape routing stay regression-testable without a browser.
// The API form is confirmed by the browser's fullscreenchange event; Esc in
// that form is handled natively by the user agent, so only the overlay form
// routes Escape through the page — and never past an open dialog.
export const FULLSCREEN_OFF='off',FULLSCREEN_API='api',FULLSCREEN_OVERLAY='overlay';

// Entering from off picks the native API when the page can request it and the
// fixed overlay otherwise; an already-active mode is idempotent.
export function requestMode(state,{apiSupported=false}={}){
  if(state===FULLSCREEN_API||state===FULLSCREEN_OVERLAY)return state;
  return apiSupported?FULLSCREEN_API:FULLSCREEN_OVERLAY;
}

// A requestFullscreen() rejection (iframe without allow="fullscreen",
// permission denied) drops the optimistic API mode to the overlay instead of
// stranding the canvas; other states pass through untouched.
export function rejectApi(state){return state===FULLSCREEN_API?FULLSCREEN_OVERLAY:state;}

// fullscreenchange verdict: the panel in the top layer means API mode, our API
// mode losing the top layer means off, and an unrelated state (overlay) is
// left alone so a foreign element going fullscreen cannot cancel the overlay.
export function apiChange(state,onPanel){
  if(onPanel)return FULLSCREEN_API;
  return state===FULLSCREEN_API?FULLSCREEN_OFF:state;
}

// Escape exits only the overlay form — the API form exits through the browser
// — and never while a modal dialog is open, so closing a node or report keeps
// the canvas fullscreen (data refreshes, interaction state survives).
export function shouldExitOnKey(state,{key='',dialogOpen=false}={}){
  return state===FULLSCREEN_OVERLAY&&key==='Escape'&&!dialogOpen;
}
