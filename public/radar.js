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
  const pointers = new Map();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let animation;
  let motion = null;
  let frame = { image: null, players: [], utility: [], focusId: null, names: true, markerScale: 1 };

  function line(x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  function grid() {
    ctx.fillStyle = '#edf1ee';
    ctx.fillRect(0, 0, size, size);
    ctx.lineWidth = 1;
    for (let index = 0; index <= 20; index += 1) {
      const step = index * size / 20;
      ctx.strokeStyle = index % 5 === 0 ? '#d1dcd4' : '#e1e8e2';
      line(step, 0, step, size);
      line(0, step, size, step);
    }
    ctx.strokeStyle = '#bdcec2';
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
      ctx.strokeStyle = '#1f9d6c';
      ctx.stroke();
    }
    const color = selected ? '#169567' : player.team === 'CT' ? '#3571b1' : player.team === 'T' ? '#a45e22' : '#2f4035';
    ctx.lineWidth = 2.5 / zoom;
    ctx.strokeStyle = '#ffffff';
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
    ctx.fillStyle = '#15251b';
    ctx.lineWidth = 4 / zoom;
    const labelX = Math.min(point.x + 18 / zoom, size - 22 / zoom);
    const labelY = Math.max(point.y - 13 / zoom, 19 / zoom);
    ctx.strokeText(player.name, labelX, labelY);
    ctx.fillText(player.name, labelX, labelY);
  }

  function drawUtility({ item, point, trail }) {
    const radius = (item.type === 'bomb' ? 7 : 6) / zoom;
    const colors = { smoke: '#39677a', flashbang: '#927a17', molotov: '#a95b34', inferno: '#a95b34', frag: '#ad554b', decoy: '#8158ab', bomb: '#a6591a' };
    const color = Object.hasOwn(colors, item.type) ? colors[item.type] : '#aac6c8';
    if (trail.length > 1) {
      ctx.save();
      ctx.globalAlpha = .65;
      ctx.lineWidth = 2 / zoom;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(trail[0].x, trail[0].y);
      for (const sample of trail.slice(1)) ctx.lineTo(sample.x, sample.y);
      ctx.stroke();
      ctx.restore();
    }
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

  function visualPlayers(time = performance.now()) {
    if (!motion) return frame.players;
    const portion = Math.min(1, Math.max(0, (time - motion.start) / motion.duration));
    if (portion === 1) {
      motion = null;
      return frame.players;
    }
    return frame.players.map(entry => {
      const start = motion.from.get(entry.player.id);
      if (!start) return entry;
      const { player, point } = entry;
      const startAngle = start.player.angle;
      const angle = Number.isFinite(startAngle) && Number.isFinite(player.angle)
        ? startAngle + (((player.angle - startAngle) % 360 + 540) % 360 - 180) * portion : player.angle;
      return {
        player: { ...player, angle },
        point: { x: start.point.x + (point.x - start.point.x) * portion, y: start.point.y + (point.y - start.point.y) * portion },
      };
    });
  }

  function focusedPoint(players) {
    return players.find(({ player }) => player.id === frame.focusId)?.point;
  }

  function tick(time) {
    animation = null;
    draw(time);
    if (motion) animation = requestAnimationFrame(tick);
  }

  function positionCenter(point) {
    if (!point) return;
    panX = (middle - point.x) * zoom;
    panY = (middle - point.y) * zoom;
    clampPan();
  }

  function draw(time) {
    const players = visualPlayers(time);
    if (frame.follow && !pointers.size) positionCenter(focusedPoint(players));
    ctx.setTransform(canvas.width / size, 0, 0, canvas.height / size, 0, 0);
    ctx.fillStyle = '#edf1ee';
    ctx.fillRect(0, 0, size, size);
    ctx.save();
    ctx.translate(middle + panX, middle + panY);
    ctx.scale(zoom, zoom);
    ctx.translate(-middle, -middle);
    if (frame.image) ctx.drawImage(frame.image, 0, 0, size, size);
    else grid();
    for (const item of frame.utility) drawUtility(item);
    for (const item of players) marker(item.player, item.point);
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
    motion = null;
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

  function pinch() {
    const [a, b] = pointers.values();
    return b ? { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
  }

  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pointers.size >= 2) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, distance: 0 });
    canvas.setPointerCapture(event.pointerId);
    if (pointers.size === 2) {
      for (const pointer of pointers.values()) pointer.distance = Infinity;
    }
  });

  canvas.addEventListener('pointermove', event => {
    const pointer = pointers.get(event.pointerId);
    if (!pointer) return;
    const before = pinch();
    const rect = canvas.getBoundingClientRect();
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    pointer.distance += Math.hypot(dx, dy);
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    const after = pinch();
    if (before?.distance > 2 && after?.distance > 2) {
      panX += (after.x - before.x) * size / rect.width;
      panY += (after.y - before.y) * size / rect.height;
      setZoom(zoom * after.distance / before.distance, (after.x - rect.left) * size / rect.width, (after.y - rect.top) * size / rect.height);
      return;
    }
    if (!after) {
      panX += dx * size / rect.width;
      panY += dy * size / rect.height;
      clampPan();
      draw();
    }
  });

  canvas.addEventListener('pointerup', event => {
    const pointer = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    if (!pointer || pointer.distance > 5) return;
    const rect = canvas.getBoundingClientRect();
    const x = middle + ((event.clientX - rect.left) * size / rect.width - middle - panX) / zoom;
    const y = middle + ((event.clientY - rect.top) * size / rect.height - middle - panY) / zoom;
    const nearby = visualPlayers().map(entry => ({ ...entry, distance: Math.hypot(entry.point.x - x, entry.point.y - y) }))
      .filter(entry => entry.distance <= 21 * frame.markerScale / zoom)
      .sort((a, b) => a.distance - b.distance)[0];
    if (nearby) onSelect(nearby.player.id);
  });

  for (const type of ['pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(type, event => pointers.delete(event.pointerId));
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
    draw({ image, players, utility, bounds, focusId, names, markerScale, follow, stamp, space, interpolate = true }) {
      const projected = players.map(player => ({ player, point: project(player, bounds) })).filter(entry => onMap(entry.point));
      projected.sort((a, b) => Number(a.player.id === focusId) - Number(b.player.id === focusId));
      const now = performance.now();
      const delay = stamp - frame.stamp;
      if (!interpolate || frame.space !== space || reducedMotion.matches || !projected.length) {
        motion = null;
      } else if (stamp !== frame.stamp) {
        const previous = new Map(visualPlayers(now).map(entry => [entry.player.id, entry]));
        const from = new Map();
        if (delay > 0 && delay < 450) {
          for (const entry of projected) {
            const start = previous.get(entry.player.id);
            if (!start || start.player.team !== entry.player.team) continue;
            const distance = Math.hypot(start.point.x - entry.point.x, start.point.y - entry.point.y);
            if (distance < size * .18) from.set(entry.player.id, start);
          }
        }
        motion = from.size ? { start: now, duration: Math.min(130, delay), from } : null;
      }
      const objects = utility.map(item => ({
        item, point: project(item, bounds),
        trail: (item.trail || []).map(sample => project(sample, bounds)).filter(onMap),
      })).filter(entry => onMap(entry.point));
      frame = { image, players: projected, utility: objects, focusId, names, markerScale, follow, stamp, space };
      draw(now);
      if (motion && animation == null) animation = requestAnimationFrame(tick);
    },
    zoomBy: factor => setZoom(zoom * factor),
    reset,
    center() {
      positionCenter(focusedPoint(visualPlayers()));
      draw();
    },
  };
}
