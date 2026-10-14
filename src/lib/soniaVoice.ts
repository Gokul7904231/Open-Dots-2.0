let activeAudio: HTMLAudioElement | null = null;

export async function speakWithSonia(text: string) {
  // 1. Sanitize Markdown, brackets, and code blocks for clean speech
  const cleanText = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[#*_~>]/g, '')
    .trim();

  if (!cleanText) return;

  // Stop any previous response if interrupted
  if (activeAudio) {
    activeAudio.pause();
    activeAudio = null;
  }

  try {
    // Uses the host IP dynamically so it works over Tailscale/mobile
    const host = window.location.hostname;
    const response = await fetch(`http://${host}:5050/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: cleanText }),
    });

    if (!response.ok) return;

    const audioBlob = await response.blob();
    const audioUrl = URL.createObjectURL(audioBlob);
    activeAudio = new Audio(audioUrl);
    await activeAudio.play();
  } catch (err) {
    console.warn('Voice playback skipped:', err);
  }
}
