// hls.js ships types only for its full build; the light build exposes the same API.
declare module 'hls.js/light' {
  export { default } from 'hls.js';
}
