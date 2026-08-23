export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back for browsers that expose the API but deny clipboard access.
    }
  }

  const textarea = document.createElement('textarea');
  const activeElement = document.activeElement;

  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  try {
    if (!document.execCommand('copy')) {
      throw new Error('Clipboard copy command was rejected');
    }
  } finally {
    document.body.removeChild(textarea);
    if (activeElement instanceof HTMLElement) {
      activeElement.focus();
    }
  }
}
