import type { GetServerSideProps } from 'next';

/**
 * Serves the flash-free theme bootstrap as a SAME-ORIGIN script at
 * /theme-init.js. Runs synchronously in <head> BEFORE first paint so the
 * document never flashes the wrong theme.
 *
 * Why an external file instead of an inline <script>: the dashboard ships a
 * strict CSP (script-src 'self', no nonce, no 'unsafe-inline'), so an inline
 * bootstrap in _document is blocked. An external script from 'self' is allowed.
 *
 * Contract (mirrors useTheme.ts):
 *   localStorage 'deerdawn-theme' = 'light' | 'dark' | (absent/'system')
 *   - explicit light/dark  → set <html data-theme="…"> (overrides the CSS media query)
 *   - system/absent        → remove data-theme, letting @media (prefers-color-scheme) drive
 * It also syncs <meta name="theme-color"> so the browser chrome bar matches.
 * The two hex values below must stay in sync with --theme-color-bar in globals.css.
 */
const THEME_INIT = `(function(){try{` +
  `var p=localStorage.getItem('deerdawn-theme');` +
  `var r=document.documentElement;` +
  `if(p==='light'||p==='dark'){r.setAttribute('data-theme',p);}else{r.removeAttribute('data-theme');}` +
  `var d=p==='dark'||(p!=='light'&&(!window.matchMedia||window.matchMedia('(prefers-color-scheme: dark)').matches));` +
  `var m=document.querySelector('meta[name="theme-color"]');` +
  `if(m)m.setAttribute('content',d?'#07111d':'#f7f9fc');` +
  `}catch(e){}})();`;

export const getServerSideProps: GetServerSideProps = async ({ res }) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400, must-revalidate');
  res.write(THEME_INIT);
  res.end();
  return { props: {} };
};

export default function ThemeInit() {
  return null;
}
