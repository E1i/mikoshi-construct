document.documentElement.dataset.lab = 'on'; console.log('lab-cs content script'); chrome.runtime.sendMessage({ lab: 'fetch', also: [...document.querySelectorAll('meta[name="lab-fetch"]')].map(meta => meta.content) }).catch(() => {})
async function sayLabel() {
  const config = await (await fetch(chrome.runtime.getURL('config.json'))).json()
  console.log(`daemon-fixture: ${config.label}`)
  document.documentElement.dataset.daemon = config.label
}
chrome.storage.local.get('daemonGo').then(({ daemonGo }) => daemonGo === true ? sayLabel() : undefined)
document.addEventListener('click', (event) => {
  if (event.target instanceof Element && event.target.closest('#daemon-go') !== null)
    chrome.storage.local.set({ daemonGo: true })
})
