chrome.runtime.onInstalled.addListener(() => { chrome.storage.local.set({ seeded: 'yes' }); console.log('lab installed') })
chrome.runtime.onMessage.addListener((message, sender) => { if (message === 'lab-fetch') { fetch(new URL('/api/ok', sender.url)).catch(() => {}); fetch('http://127.0.0.1:1000/').catch(() => {}) } })
