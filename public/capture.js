const maxSide = 480;
const captureInterval = 80;
const networkInterval = 125;

function cropRegion(width, height, selection) {
  const side = Math.round(Math.min(width, height) * selection.scale / 1000);
  return {
    x: Math.round((width - side) * selection.x / 1000),
    y: Math.round((height - side) * selection.y / 1000),
    side,
  };
}

function createHudCapture({ desktop, api, onFrame, onState, canShare }) {
  const $ = id => document.getElementById(id);
  const dialog = $('captureDialog');
  const sourcePanel = $('captureSourcePanel');
  const cropPanel = $('captureCropPanel');
  const preview = $('capturePreview');
  const previewContext = preview.getContext('2d');
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  const frame = document.createElement('canvas');
  frame.width = frame.height = maxSide;
  const context = frame.getContext('2d', { alpha: false });
  const controls = { x: $('cropX'), y: $('cropY'), scale: $('cropScale') };
  let stream;
  let approved;
  let timer;
  let pending;
  let busy = false;
  let generation = 0;
  let lastSend = 0;

  function message(text) {
    $('captureMessage').textContent = text;
  }

  function draft() {
    return Object.fromEntries(Object.entries(controls).map(([key, control]) => [key, Number(control.value)]));
  }

  function drawPreview() {
    if (!dialog.open || cropPanel.hidden) return;
    const scale = Math.min(1, 1200 / video.videoWidth);
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    if (preview.width !== width || preview.height !== height) {
      preview.width = width;
      preview.height = height;
    }
    const { x, y, side } = cropRegion(width, height, draft());
    previewContext.drawImage(video, 0, 0, width, height);
    previewContext.fillStyle = '#1118';
    previewContext.fillRect(0, 0, width, y);
    previewContext.fillRect(0, y + side, width, height - y - side);
    previewContext.fillRect(0, y, x, side);
    previewContext.fillRect(x + side, y, width - x - side, side);
    previewContext.strokeStyle = '#43f5ab';
    previewContext.lineWidth = 3;
    previewContext.strokeRect(x, y, side, side);
  }

  function publish() {
    const now = performance.now();
    if (!approved?.share || !canShare() || pending || now - lastSend < networkInterval) return;
    lastSend = now;
    const current = generation;
    pending = new Promise(resolve => frame.toBlob(resolve, 'image/jpeg', .72)).then(blob => {
      if (blob && current === generation && approved?.share && canShare()) return api.sendCapture(blob);
    }).catch(() => {}).finally(() => { pending = null; });
  }

  function tick() {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return;
    drawPreview();
    if (!approved) return;
    const { x, y, side } = cropRegion(video.videoWidth, video.videoHeight, approved);
    context.drawImage(video, x, y, side, side, 0, 0, maxSide, maxSide);
    onFrame(frame);
    publish();
  }

  function stop() {
    const previous = approved;
    const ending = ++generation;
    clearInterval(timer);
    for (const track of stream?.getTracks() || []) track.stop();
    stream = null;
    approved = null;
    busy = false;
    video.srcObject = null;
    previewContext.clearRect(0, 0, preview.width, preview.height);
    if (previous) {
      onState(false);
      if (previous.share) Promise.resolve(pending).finally(() => {
        if (ending === generation) void api.clearCapture().catch(() => {});
      });
    }
  }

  function showCrop() {
    sourcePanel.hidden = true;
    cropPanel.hidden = false;
    if (approved) {
      for (const [key, control] of Object.entries(controls)) control.value = approved[key];
      $('captureLan').checked = approved.share;
    }
    message('Ustaw kwadrat na minimapie. Na podgląd trafi wybrany kadr.');
    if (!dialog.open) dialog.showModal();
    drawPreview();
  }

  async function start(source) {
    if (busy) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      message('Otwórz radar na komputerze na adresie 127.0.0.1 i użyj Chrome lub Edge albo aplikacji desktopowej.');
      if (!dialog.open) dialog.showModal();
      return;
    }
    busy = true;
    $('captureLan').checked = false;
    const current = ++generation;
    try {
      if (desktop && !await desktop.selectCapture(source)) throw new Error('To okno nie jest już dostępne. Wybierz źródło ponownie.');
      const media = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 20, max: 30 }, displaySurface: 'window' },
        audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude',
      });
      if (current !== generation) {
        media.getTracks().forEach(track => track.stop());
        return;
      }
      stream = media;
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('Wybrane źródło nie udostępniło obrazu.');
      track.addEventListener('ended', () => {
        if (stream !== media) return;
        stop();
        if (dialog.open) dialog.close();
        onState(false, 'Przechwytywanie zakończone przez system.');
      }, { once: true });
      video.srcObject = stream;
      await video.play();
      if (current !== generation) return;
      clearInterval(timer);
      timer = setInterval(tick, captureInterval);
      showCrop();
    } catch (error) {
      if (current !== generation) return;
      stop();
      const detail = error.name === 'NotAllowedError' || error.name === 'AbortError'
        ? 'Wybór okna anulowany. Spróbuj ponownie, gdy CS2 jest otwarte.'
        : error.message;
      onState(false, detail);
      if (dialog.open) {
        sourcePanel.hidden = true;
        cropPanel.hidden = true;
        message(detail);
      }
    } finally {
      if (current === generation) busy = false;
    }
  }

  async function open() {
    if (busy) return;
    if (stream) return showCrop();
    if (!desktop) return start();
    busy = true;
    cropPanel.hidden = true;
    sourcePanel.hidden = true;
    message('Szukam otwartych okien i ekranów.');
    dialog.showModal();
    try {
      const sources = await desktop.captureSources();
      if (!dialog.open) return;
      if (!sources.length) throw new Error('Brak dostępnych okien. Najpierw uruchom CS2.');
      $('captureSource').replaceChildren(...sources.map(item => new Option(item.name, item.id)));
      sourcePanel.hidden = false;
      message('Wybierz okno Counter-Strike 2. Jeśli grasz w trybie pełnoekranowym, możesz wybrać ekran z grą.');
    } catch (error) {
      message(error.message);
    } finally {
      busy = false;
    }
  }

  function place(event) {
    const rect = preview.getBoundingClientRect();
    const { side } = cropRegion(preview.width, preview.height, draft());
    const x = (event.clientX - rect.left) * preview.width / rect.width - side / 2;
    const y = (event.clientY - rect.top) * preview.height / rect.height - side / 2;
    const clamp = value => Math.min(1000, Math.max(0, Math.round(value)));
    controls.x.value = clamp(x * 1000 / (preview.width - side));
    controls.y.value = clamp(y * 1000 / (preview.height - side));
    drawPreview();
  }

  preview.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    preview.setPointerCapture(event.pointerId);
    place(event);
  });
  preview.addEventListener('pointermove', event => {
    if (preview.hasPointerCapture(event.pointerId)) place(event);
  });
  for (const control of Object.values(controls)) control.addEventListener('input', drawPreview);
  $('captureSourceButton').addEventListener('click', () => void start($('captureSource').value));
  $('captureApply').addEventListener('click', () => {
    if (!stream || !video.videoWidth) return;
    const previous = approved;
    const current = ++generation;
    approved = { ...draft(), share: $('captureLan').checked };
    if (previous?.share && !approved.share) Promise.resolve(pending).finally(() => {
      if (current === generation) void api.clearCapture().catch(() => {});
    });
    dialog.close();
    onState(true);
    tick();
  });
  $('captureClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { if (!approved) stop(); });
  window.addEventListener('pagehide', stop);

  return { open, stop };
}

export { createHudCapture };
