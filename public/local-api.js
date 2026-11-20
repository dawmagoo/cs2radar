function createLocalApi(readToken) {
  async function request(url, options = {}) {
    const headers = new Headers(options.headers);
    const token = readToken();
    if (token) headers.set('X-View-Token', token);
    headers.set('X-WebRadar-Local', '1');
    const response = await fetch(url, { signal: AbortSignal.timeout(6000), ...options, headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  }

  function mapRoute(key) {
    const [map, floor] = key.split(':');
    return `/api/maps/${encodeURIComponent(map)}/${encodeURIComponent(floor)}`;
  }

  function putJson(url, body) {
    return request(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  return {
    mapInfo: async key => (await request(mapRoute(key))).json(),
    mapImage: async key => (await request(`${mapRoute(key)}/image`)).blob(),
    saveImage: (key, file) => request(`${mapRoute(key)}/image`, {
      method: 'PUT', headers: { 'Content-Type': file.type }, body: file, signal: AbortSignal.timeout(15_000),
    }),
    removeImage: key => request(`${mapRoute(key)}/image`, { method: 'DELETE' }),
    saveBounds: (key, bounds) => putJson(`${mapRoute(key)}/bounds`, bounds),
    resetBounds: key => request(`${mapRoute(key)}/bounds`, { method: 'DELETE' }),
    startCstv: url => putJson('/api/cstv', { url }),
    stopCstv: () => request('/api/cstv', { method: 'DELETE' }),
    sendCapture: frame => request('/api/capture/frame', {
      method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: frame, signal: AbortSignal.timeout(1200),
    }),
    clearCapture: () => request('/api/capture/frame', { method: 'DELETE', keepalive: true }),
    shareStatus: async () => (await request('/api/share')).json(),
    shareStart: async ip => (await putJson('/api/share', { ip })).json(),
    shareStop: async () => (await request('/api/share', { method: 'DELETE' })).json(),
  };
}

export { createLocalApi };
