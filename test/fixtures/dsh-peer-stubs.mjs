function scrubbedParentEnv() {
  return { PATH: process.env.PATH ?? '' }
}

function assertSupportedJsonSchema() {}

export { assertSupportedJsonSchema, scrubbedParentEnv }

