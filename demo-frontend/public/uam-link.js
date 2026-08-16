/** UAM frontend URL — Render: UAM_FRONTEND_URL via runtime-config.js; dev: hostname:8091 */
function uamUrl(path) {
  if (window.UAM_FRONTEND_URL) {
    return `${window.UAM_FRONTEND_URL.replace(/\/$/, '')}${path}`;
  }
  const port = window.UAM_FRONTEND_PORT || '8091';
  return `${window.location.protocol}//${window.location.hostname}:${port}${path}`;
}
