// Pure URL identity shared by the classic extension worker and the Node host.
function canonicalProjectPath(path) {
  return path.replace(/^(\/g\/g-p-[a-f0-9]{32})(?:-[^/]+)?(?=\/)/i, '$1')
}

function retirementTarget(url) {
  try {
    const parsed = new URL(url)
    if (parsed.origin !== 'https://chatgpt.com' || parsed.username || parsed.password) return null
    const match = parsed.pathname.match(/^\/(?:g\/g-p-[^/]+\/)?c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i)
    return match ? `https://chatgpt.com/c/${match[1].toLowerCase()}` : null
  } catch { return null }
}

function manualRetirementTarget(url) {
  const canonical = retirementTarget(url)
  if (canonical) return canonical
  try {
    const parsed = new URL(url)
    if (parsed.origin !== 'https://chatgpt.com' || parsed.username || parsed.password || parsed.port) return null
    const path = canonicalProjectPath(parsed.pathname)
    if (path === '/') return 'https://chatgpt.com/'
    return /^\/g\/g-p-[^/]+\/project\/?$/.test(path)
      ? `https://chatgpt.com${path.replace(/\/$/, '')}` : null
  } catch { return null }
}

if (typeof module !== 'undefined') {
  module.exports.canonicalProjectPath = canonicalProjectPath
  module.exports.retirementTarget = retirementTarget
  module.exports.manualRetirementTarget = manualRetirementTarget
}
