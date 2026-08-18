const formatMeta = (meta) => {
  if (!meta || typeof meta !== 'object') return '';
  const s = JSON.stringify(meta);
  return s === '{}' ? '' : ' ' + s;
};

const log = (level, message, meta) => {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${formatMeta(meta)}`;
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.log(line);
};

module.exports = {
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
};
