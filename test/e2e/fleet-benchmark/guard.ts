const original = globalThis.fetch

globalThis.fetch = function loopbackOnly(input, init) {
  const url = new URL(input instanceof Request ? input.url : input)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error(`Benchmark refuses non-loopback fetch: ${url.origin}`)
  return original(input, init)
}
