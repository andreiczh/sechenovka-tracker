// Retry transient transport failures once. Do not retry memory/runtime failures.
export async function loadVoiceModel(factory, { onRetry = () => {}, delay = () => new Promise(resolve => setTimeout(resolve, 1500)) } = {}) {
  try { return await factory(); }
  catch (error) {
    if(!/fetch|network|download|connection|HTTP\s*5\d\d/i.test(String(error?.message || '')))throw error;
    onRetry();await delay();return factory();
  }
}
