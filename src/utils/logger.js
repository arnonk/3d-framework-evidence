function info(...args) { console.log('[info]', ...args); }
function warn(...args) { console.warn('[warn]', ...args); }
function error(...args) { console.error('[error]', ...args); }
module.exports = { info, warn, error };
