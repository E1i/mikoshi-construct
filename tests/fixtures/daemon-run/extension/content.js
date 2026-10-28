document.documentElement.dataset.lab = 'on'; console.log('lab-cs content script'); chrome.runtime.sendMessage('lab-fetch').catch(() => {})
document.addEventListener('click', async (event) => {
  if (!(event.target instanceof Element) || event.target.closest('#daemon-go') === null)
    return
  const config = await (await fetch(chrome.runtime.getURL('config.json'))).json()
  console.log(`daemon-fixture: ${config.label}`)
})
