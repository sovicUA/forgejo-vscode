module.exports = { workspace: { getConfiguration: () => ({ get: k => ({ url: 'x', cloneProtocol: 'ssh', defaultPrivate: true })[k], update: async () => {} }) },
  window: {}, commands: {}, env: {}, Uri: {}, ProgressLocation: {}, ConfigurationTarget: { Global: 1 }, extensions: {} };
