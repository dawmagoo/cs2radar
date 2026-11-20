const size = 800;
const middle = size / 2;

export function project(player, bounds) {
  if (!Number.isFinite(player?.x) || !Number.isFinite(player?.y)) return null;
  return {
    x: (player.x - bounds.minx) / (bounds.maxx - bounds.minx) * size,
    y: (bounds.maxy - player.y) / (bounds.maxy - bounds.miny) * size,
  };
}

export function onMap(point) {
  return point && point.x >= 0 && point.x <= size && point.y >= 0 && point.y <= size;
}

export function createRadar(canvas, onZoom, onSelect) {
  const ctx = canvas.getContext('2d');
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let pointer;
  let frame = { image: null, players: [], utility: [], focusId: null, names: true, markerScale: 1 };

  function line(x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  function grid() {
    ctx.fillStyle = '#152329';
    ctx.fillRect(0, 0, size, size);
    ctx.lineWidth = 1;
    for (let index = 0; index <= 20; index += 1) {
      const step = index * size / 20;
      ctx.strokeStyle = index % 5 === 0 ? '#354e55' : '#25383e';
      line(step, 0, step, size);
      line(0, step, size, step);
    }
    ctx.strokeStyle = '#39535b';
    ctx.setLineDash([4, 7]);
    for (const radius of [size / 8, size / 4, size * 3 / 8]) {
      ctx.beginPath();
      ctx.arc(middle, middle, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  function marker(player, point) {
    const selected = frame.focusId === player.id;
    const radius = (selected ? 12 : 9) * frame.markerScale / zoom;
    if (selected) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius * 1.75, 0, Math.PI * 2);
      ctx.lineWidth = 2 / zoom;
      ctx.strokeStyle = '#defff1';
      ctx.stroke();
    }
    const color = player.team === 'CT' ? '#91c8ff' : player.team === 'T' ? '#ffd092' : '#8aefc7';
    ctx.lineWidth = 2.5 / zoom;
    ctx.strokeStyle = '#111b20';
    ctx.fillStyle = color;
    ctx.beginPath();
    if (Number.isFinite(player.angle)) {
      ctx.save();
      ctx.translate(point.x, point.y);
      ctx.rotate(-player.angle * Math.PI / 180);
      ctx.moveTo(radius * 1.6, 0);
      ctx.lineTo(-radius, -radius * .82);
      ctx.lineTo(-radius * .58, 0);
      ctx.lineTo(-radius, radius * .82);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (!frame.names) return;
    ctx.font = `600 ${(selected ? 16 : 14) * frame.markerScale / zoom}px system-ui`;
    ctx.fillStyle = '#f3fafc';
    ctx.lineWidth = 4 / zoom;
    const labelX = Math.min(point.x + 18 / zoom, size - 22 / zoom);
    const labelY = Math.max(point.y - 13 / zoom, 19 / zoom);
    ctx.strokeText(player.name, labelX, labelY);
    ctx.fillText(player.name, labelX, labelY);
  }

  function drawUtility({ item, point }) {
    const radius = (item.type === 'bomb' ? 7 : 6) / zoom;
    const colors = { smoke: '#b9d5e0', flashbang: '#fbf0b6', molotov: '#ffad78', inferno: '#ffad78', frag: '#ffa29b', decoy: '#cbaaff', bomb: '#ffd092' };
    const color = Object.hasOwn(colors, item.type) ? colors[item.type] : '#aac6c8';
    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 / zoom;
    ctx.beginPath();
    if (item.type === 'bomb') {
      ctx.moveTo(0, -radius);
      ctx.lineTo(radius, 0);
      ctx.lineTo(0, radius);
      ctx.lineTo(-radius, 0);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.stroke();
      if (item.effectTime > 0) {
        ctx.globalAlpha = .28;
        ctx.beginPath();
        ctx.arc(0, 0, radius * 1.7, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function focusedPoint() {
    return frame.players.find(({ player }) => player.id === frame.focusId)?.point;
  }

  function positionCenter(point) {
    if (!point) return;
    panX = (middle - point.x) * zoom;
    panY = (middle - point.y) * zoom;
    clampPan();
  }

  function draw() {
    ctx.setTransform(canvas.width / size, 0, 0, canvas.height / size, 0, 0);
    ctx.fillStyle = '#0e181c';
    ctx.fillRect(0, 0, size, size);
    ctx.save();
    ctx.translate(middle + panX, middle + panY);
    ctx.scale(zoom, zoom);
    ctx.translate(-middle, -middle);
    if (frame.image) ctx.drawImage(frame.image, 0, 0, size, size);
    else grid();
    for (const item of frame.utility) drawUtility(item);
    for (const item of frame.players) marker(item.player, item.point);
    ctx.restore();
  }

  function clampPan() {
    const limit = middle * zoom + middle * .65;
    panX = Math.max(-limit, Math.min(limit, panX));
    panY = Math.max(-limit, Math.min(limit, panY));
  }

  function setZoom(value, x = middle, y = middle) {
    const next = Math.max(.5, Math.min(8, value));
    const factor = next / zoom;
    panX = x - middle - (x - middle - panX) * factor;
    panY = y - middle - (y - middle - panY) * factor;
    zoom = next;
    clampPan();
    onZoom(zoom);
    draw();
  }

  function reset() {
    zoom = 1;
    panX = 0;
    panY = 0;
    onZoom(zoom);
    draw();
  }

  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    setZoom(zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12),
      (event.clientX - rect.left) * size / rect.width, (event.clientY - rect.top) * size / rect.height);
  }, { passive: false });

  canvas.addEventListener('pointerdown', event => {
    if (pointer || event.button !== 0) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, distance: 0 };
    canvas.setPointerCapture(pointer.id);
  });

  canvas.addEventListener('pointermove', event => {
    if (event.pointerId !== pointer?.id) return;
    const rect = canvas.getBoundingClientRect();
    pointer.distance += Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y);
    panX += (event.clientX - pointer.x) * size / rect.width;
    panY += (event.clientY - pointer.y) * size / rect.height;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    clampPan();
    draw();
  });

  canvas.addEventListener('pointerup', event => {
    if (event.pointerId !== pointer?.id || pointer.distance > 5) return;
    const rect = canvas.getBoundingClientRect();
    const x = middle + ((event.clientX - rect.left) * size / rect.width - middle - panX) / zoom;
    const y = middle + ((event.clientY - rect.top) * size / rect.height - middle - panY) / zoom;
    const nearby = frame.players.map(entry => ({ ...entry, distance: Math.hypot(entry.point.x - x, entry.point.y - y) }))
      .filter(entry => entry.distance <= 21 * frame.markerScale / zoom)
      .sort((a, b) => a.distance - b.distance)[0];
    if (nearby) onSelect(nearby.player.id);
  });

  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(type, event => { if (event.pointerId === pointer?.id) pointer = null; });
  }

  new ResizeObserver(([entry]) => {
    const dimension = Math.round(entry.contentRect.width * Math.min(3, window.devicePixelRatio));
    if (dimension > 0 && canvas.width !== dimension) {
      canvas.width = dimension;
      canvas.height = dimension;
      draw();
    }
  }).observe(canvas);

  return {
    draw({ image, players, utility, bounds, focusId, names, markerScale, follow }) {
      const projected = players.map(player => ({ player, point: project(player, bounds) })).filter(entry => onMap(entry.point));
      projected.sort((a, b) => Number(a.player.id === focusId) - Number(b.player.id === focusId));
      frame = { image, players: projected, utility: utility.map(item => ({ item, point: project(item, bounds) })).filter(entry => onMap(entry.point)),
        focusId, names, markerScale };
      if (follow) positionCenter(focusedPoint());
      draw();
    },
    zoomBy: factor => setZoom(zoom * factor),
    reset,
    center() {
      positionCenter(focusedPoint());
      draw();
    },
  };
}
