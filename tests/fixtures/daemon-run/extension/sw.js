chrome.runtime.onInstalled.addListener(() => { chrome.storage.local.set({ seeded: 'yes' }); console.log('lab installed') })
chrome.runtime.onMessage.addListener((message, sender) => { if (message?.lab === 'fetch') { fetch(new URL('/api/ok', sender.url)).catch(() => {}); for (const url of message.also) fetch(url).catch(() => {}) } })
