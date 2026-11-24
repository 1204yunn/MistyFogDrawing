let loading;

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const fail = () => {
        clearTimeout(timer);
        script.remove();
        reject(new Error('無法載入人機驗證'));
      };
      const timer = setTimeout(fail, 12000);
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.onerror = fail;
      script.onload = () => {
        clearTimeout(timer);
        if (window.turnstile) resolve(window.turnstile);
        else fail();
      };
      document.head.append(script);
    }).catch(error => {
      loading = undefined;
      throw error;
    });
  }
  return loading;
}

async function getToken(container, sitekey, signal) {
  const api = await loadTurnstile();
  signal.throwIfAborted();
  let widget;
  let timer;
  let fail;
  try {
    container.hidden = false;
    return await new Promise((resolve, reject) => {
      fail = () => reject(new Error('人機驗證未完成'));
      timer = setTimeout(fail, 120000);
      signal.addEventListener('abort', fail, { once: true });
      widget = api.render(container, {
        sitekey,
        action: 'misty_upload',
        size: container.clientWidth < 300 ? 'compact' : 'flexible',
        appearance: 'interaction-only',
        retry: 'never',
        callback: resolve,
        'error-callback': fail,
        'expired-callback': fail,
        'timeout-callback': fail,
        'unsupported-callback': fail,
      });
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', fail);
    if (widget !== undefined) api.remove(widget);
    container.hidden = true;
  }
}

export async function uploadArtwork({ blob, submissionId, container, config, signal, onVerified }) {
  const token = await getToken(container, config.turnstileSiteKey, signal);
  signal.throwIfAborted();
  onVerified();
  const response = await fetch(config.endpoint, {
    method: 'POST',
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(50000)]),
    headers: {
      'Content-Type': 'image/png',
      'X-Submission-Id': submissionId,
      'X-Consent': 'yes',
      'X-Turnstile-Token': token,
    },
    body: blob,
  });
  if (!response.ok) throw new Error('Worker rejected upload');
  return response.json();
}
