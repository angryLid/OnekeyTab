import './style.css';
import { getLastError, getConfig, setConfig } from '@/lib/config';
import { verifyApiKey } from '@/lib/llm';

const input = document.querySelector<HTMLInputElement>('#api-key')!;
const saveButton = document.querySelector<HTMLButtonElement>('#save')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const errorSection = document.querySelector<HTMLElement>('#error-section')!;
const lastError = document.querySelector<HTMLParagraphElement>('#last-error')!;
const lastErrorTime = document.querySelector<HTMLParagraphElement>('#last-error-time')!;

function setStatus(message: string, kind: 'ok' | 'error' | 'muted'): void {
  status.textContent = message;
  status.className = kind;
}

async function init(): Promise<void> {
  const config = await getConfig();
  if (config?.apiKey) input.value = config.apiKey;

  const error = await getLastError();
  if (error) {
    errorSection.hidden = false;
    lastError.textContent = error.message;
    lastErrorTime.textContent = new Date(error.timestamp).toLocaleString();
  }
}

saveButton.addEventListener('click', async () => {
  const apiKey = input.value.trim();
  if (!apiKey) {
    setStatus('Please enter an API key.', 'error');
    return;
  }
  saveButton.disabled = true;
  setStatus('Verifying…', 'muted');
  try {
    await verifyApiKey(apiKey);
    await setConfig({ provider: 'openrouter', apiKey });
    setStatus('API key verified — saved.', 'ok');
    errorSection.hidden = true;
  } catch (e) {
    setStatus(`Verification failed: ${(e as Error).message}`, 'error');
  } finally {
    saveButton.disabled = false;
  }
});

void init();
