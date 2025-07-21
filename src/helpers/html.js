export function injectScript (html, scriptContent) {
  const scriptTag = `<script>${scriptContent}</script>`

  if (/<head[^>]*>/i.test(html)) { // <head> exists -> inject script
    return html.replace(/<head[^>]*>/i, (match) => `${match}${scriptTag}`)
  } else if (/<html[^>]*>/i.test(html)) { // <html> exists but no <head> -> add <head> after <html>
    return html.replace(/<html[^>]*>/i, `$&<head>${scriptTag}</head>`)
  } else if (/<!doctype[^>]*>/i.test(html)) { // <!doctype> exists but no <html> -> add <html><head> after doctype
    return html.replace(/<!doctype[^>]*>/i, (match) => `${match}<html><head>${scriptTag}</head>`)
  } else { // No structure -> wrap entire content in proper HTML skeleton
    return `<!doctype html><html><head>${scriptTag}</head>${html}</html>`
  }
}
