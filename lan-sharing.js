'use strict';

const { randomBytes } = require('node:crypto');
const { networkInterfaces } = require('node:os');

function localAddresses() {
  const addresses = new Map();
  const privateIp = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
  for (const [name, records] of Object.entries(networkInterfaces())) {
    for (const record of records || []) {
      if (record.family === 'IPv4' && !record.internal && privateIp.test(record.address)) addresses.set(record.address, name);
    }
  }
  return [...addresses].map(([ip, name]) => ({ ip, name }));
}

function createLanSharing(startListener, addresses = localAddresses) {
  let share;
  let pending = Promise.resolve();
  let disposed = false;

  function status() {
    return { addresses: addresses(), link: share?.link ?? '', ip: share?.ip ?? '' };
  }

  function change(operation) {
    if (disposed) return Promise.reject(new Error('Udostępnianie jest zamykane.'));
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }

  async function closeListener() {
    const previous = share;
    share = null;
    if (previous) await previous.close();
  }

  return {
    status,
    active: () => Boolean(share),
    start(ip) {
      return change(async () => {
        if (!addresses().some(address => address.ip === ip)) {
          const error = new Error('Wybierz dostępny adres sieci lokalnej.');
          error.status = 400;
          throw error;
        }
        if (share?.ip === ip) return status();
        await closeListener();
        const token = randomBytes(24).toString('hex');
        const { port, close } = await startListener(ip, token);
        share = { close, ip, link: `http://${ip}:${port}/#token=${token}` };
        return status();
      });
    },
    stop() {
      return change(async () => {
        await closeListener();
        return status();
      });
    },
    async dispose() {
      disposed = true;
      await pending;
      await closeListener();
    },
  };
}

module.exports = { createLanSharing };
