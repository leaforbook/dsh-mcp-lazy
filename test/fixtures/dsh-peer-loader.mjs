const stubUrl = new URL('./dsh-peer-stubs.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-subprocess' || specifier === '@deepseek-ai/dsh-tools') {
    return { url: stubUrl, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

